import { authGuard } from '@api/guards/auth.guard';
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Auth, ConfigService, CustomAi as CustomAiEnv } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import multer from 'multer';

import { ConversationController } from '../controllers/conversation.controller';
import { CustomAiController } from '../controllers/customAi.controller';
import { KnowledgeController } from '../controllers/knowledge.controller';
import { SettingsController } from '../controllers/settings.controller';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
});

export class CustomAiRouter {
  public readonly router: Router;
  private readonly logger = new Logger('CustomAiRouter');

  constructor(
    private readonly customAiController: CustomAiController,
    private readonly knowledgeController: KnowledgeController,
    private readonly settingsController: SettingsController,
    private readonly conversationController: ConversationController,
    private readonly waMonitor: WAMonitoringService,
    private readonly prismaRepository: PrismaRepository,
    private readonly configService: ConfigService,
  ) {
    this.router = Router();
    this.initRoutes();
  }

  /**
   * Unified Authentication Guard:
   * Accepts:
   * 1. 'apikey' header matching AUTHENTICATION_API_KEY
   * 2. 'Authorization: Bearer <token>' matching AUTHENTICATION_API_KEY or CUSTOM_AI_ADMIN_PASSWORD
   */
  private adminAuthMiddleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      const globalKey = this.configService.get<Auth>('AUTHENTICATION')?.API_KEY?.KEY;
      const adminPassword = this.configService.get<CustomAiEnv>('CUSTOM_AI')?.ADMIN_PASSWORD;

      const headerApiKey = req.get('apikey');
      const authHeader = req.get('authorization');
      let bearerToken: string | undefined;

      if (authHeader && authHeader.startsWith('Bearer ')) {
        bearerToken = authHeader.substring(7).trim();
      }

      const token = headerApiKey || bearerToken;

      // Allow if token matches global API key or admin password
      if (token && ((globalKey && token === globalKey) || (adminPassword && token === adminPassword))) {
        return next();
      }

      // If no admin password or global key is set (unconfigured), allow local dev
      if (!globalKey && !adminPassword) {
        return next();
      }

      return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key / Admin password' });
    };
  }

  private initRoutes() {
    const auth = this.adminAuthMiddleware();

    // 1. Auth check endpoint
    this.router.post('/auth/verify', async (req: Request, res: Response) => {
      const { password, apiKey } = req.body;
      const globalKey = this.configService.get<Auth>('AUTHENTICATION')?.API_KEY?.KEY;
      const adminPassword = this.configService.get<CustomAiEnv>('CUSTOM_AI')?.ADMIN_PASSWORD;

      const token = apiKey || password;
      const isValid = Boolean(
        token && ((globalKey && token === globalKey) || (adminPassword && token === adminPassword)),
      );

      if (isValid || (!globalKey && !adminPassword)) {
        return res.json({ success: true, message: 'Authentication successful', token });
      }
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    });

    // 2. Dashboard status & stats
    this.router.get('/status', auth, async (req: Request, res: Response) => {
      try {
        const instanceName = req.query.instanceName as string;
        const stats = await this.customAiController.getDashboardStats(instanceName);
        return res.json(stats);
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    // 3. Instances list
    this.router.get('/instances', auth, async (req: Request, res: Response) => {
      try {
        const instances = await this.prismaRepository.instance.findMany({
          select: {
            id: true,
            name: true,
            connectionStatus: true,
            number: true,
            profileName: true,
            profilePicUrl: true,
            updatedAt: true,
          },
        });

        // Enrich with live waMonitor state
        const enriched = instances.map((inst) => {
          const live = this.waMonitor.waInstances[inst.name];
          return {
            ...inst,
            state: live?.connectionStatus?.state || inst.connectionStatus,
            qr: live?.connectionStatus?.qrcode,
          };
        });

        return res.json(enriched);
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    // 4. WhatsApp Connect / QR Code for an instance
    this.router.get('/instances/:instanceName/connect', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        const live = this.waMonitor.waInstances[instanceName];
        if (!live) {
          return res.status(404).json({ error: `Instance ${instanceName} not loaded` });
        }
        const state = await live.connectToWhatsapp();
        return res.json(state);
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    // 5. Settings Endpoints
    this.router.get('/settings/:instanceName', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        const settings = await this.settingsController.getSettings(instanceName);
        return res.json(settings);
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    this.router.post('/settings/:instanceName', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        const response = await this.settingsController.updateSettings(instanceName, req.body);
        return res.json(response);
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    // 6. Knowledge Base Endpoints
    this.router.get('/knowledge/:instanceName', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        const documents = await this.knowledgeController.getDocuments(instanceName);
        return res.json(documents);
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    this.router.post(
      '/knowledge/:instanceName/upload',
      auth,
      upload.single('file'),
      async (req: Request, res: Response) => {
        try {
          const { instanceName } = req.params;
          if (!req.file) {
            return res.status(400).json({ error: 'No file provided in form-data' });
          }
          const doc = await this.knowledgeController.uploadFile(instanceName, req.file);
          return res.status(201).json(doc);
        } catch (err: any) {
          return res.status(400).json({ error: err.message });
        }
      },
    );

    this.router.post('/knowledge/:instanceName/faq', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        const doc = await this.knowledgeController.addFaq(instanceName, req.body);
        return res.status(201).json(doc);
      } catch (err: any) {
        return res.status(400).json({ error: err.message });
      }
    });

    this.router.post('/knowledge/:instanceName/url', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        const { url } = req.body;
        const doc = await this.knowledgeController.addUrl(instanceName, url);
        return res.status(201).json(doc);
      } catch (err: any) {
        return res.status(400).json({ error: err.message });
      }
    });

    this.router.post('/knowledge/:instanceName/business-info', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        const doc = await this.knowledgeController.saveBusinessInfo(instanceName, req.body);
        return res.status(201).json(doc);
      } catch (err: any) {
        return res.status(400).json({ error: err.message });
      }
    });

    this.router.get('/knowledge/:instanceName/search', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        const query = req.query.q as string;
        const topK = Number(req.query.topK) || 4;
        const results = await this.knowledgeController.searchKnowledge(instanceName, query, topK);
        return res.json(results);
      } catch (err: any) {
        return res.status(400).json({ error: err.message });
      }
    });

    this.router.delete('/knowledge/:instanceName/:documentId', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName, documentId } = req.params;
        const result = await this.knowledgeController.deleteDocument(instanceName, documentId);
        return res.json(result);
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    this.router.post('/knowledge/:instanceName/:documentId/reprocess', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName, documentId } = req.params;
        const result = await this.knowledgeController.reprocessDocument(instanceName, documentId);
        return res.json(result);
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    // 7. Conversation Inbox Endpoints
    this.router.get('/conversations/:instanceName', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        const convs = await this.conversationController.getConversations(instanceName);
        return res.json(convs);
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    this.router.get('/conversations/:instanceName/messages', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        const remoteJid = req.query.remoteJid as string;
        const data = await this.conversationController.getMessages(instanceName, remoteJid);
        return res.json(data);
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    this.router.post('/conversations/:instanceName/pause', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        const { remoteJid } = req.body;
        const result = await this.conversationController.pauseAi(instanceName, remoteJid);
        return res.json(result);
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    this.router.post('/conversations/:instanceName/resume', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        const { remoteJid } = req.body;
        const result = await this.conversationController.resumeAi(instanceName, remoteJid);
        return res.json(result);
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    this.router.post('/conversations/:instanceName/takeover', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        const { remoteJid, reason } = req.body;
        const result = await this.conversationController.markHumanTakeover(instanceName, remoteJid, reason);
        return res.json(result);
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    this.router.post('/conversations/:instanceName/reply', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        const { remoteJid, text } = req.body;
        const result = await this.conversationController.sendHumanReply(instanceName, remoteJid, text);
        return res.json(result);
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });
  }
}
