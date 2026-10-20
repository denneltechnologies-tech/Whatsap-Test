import { InstanceController } from '@api/controllers/instance.controller';
import { authGuard } from '@api/guards/auth.guard';
import { PrismaRepository } from '@api/repository/repository.service';
import { WAMonitoringService } from '@api/services/monitor.service';
import { Integration } from '@api/types/wa.types';
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
    private readonly instanceController?: InstanceController,
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
        let enriched = instances.map((inst) => {
          const live = this.waMonitor.waInstances[inst.name];
          return {
            ...inst,
            state: live?.connectionStatus?.state || inst.connectionStatus,
            qr: live?.connectionStatus?.qrcode,
          };
        });

        // If no instances exist yet in database, auto-create the "default" instance
        if (enriched.length === 0 && this.instanceController) {
          try {
            this.logger.info('No instances found in DB, auto-creating "default" instance with Baileys...');
            await this.instanceController.createInstance({
              instanceName: 'default',
              integration: Integration.WHATSAPP_BAILEYS,
              qrcode: true,
            } as any);

            const live = this.waMonitor.waInstances['default'];
            enriched = [
              {
                id: 'default',
                name: 'default',
                connectionStatus: live?.connectionStatus?.state || 'connecting',
                number: null,
                profileName: 'Default',
                profilePicUrl: null,
                updatedAt: new Date(),
                state: live?.connectionStatus?.state || 'connecting',
                qr: live?.connectionStatus?.qrcode,
              },
            ];
          } catch (autoErr: any) {
            this.logger.warn(`Could not auto-create default instance: ${autoErr?.message || autoErr}`);
          }
        }

        return res.json(enriched);
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    // 4. WhatsApp Connect / QR Code / Pairing Code for an instance
    this.router.get('/instances/:instanceName/connect', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        const number = req.query.number ? String(req.query.number).replace(/[^0-9]/g, '') : null;
        let live = this.waMonitor.waInstances[instanceName];

        const dbInstance = await this.prismaRepository.instance.findFirst({
          where: { name: instanceName },
        });

        // Ensure in-memory live instance and DB record exist and are synchronized
        if (!dbInstance || !live || live.instanceId !== dbInstance.id) {
          this.logger.info(`Instance "${instanceName}" missing or desynced between DB and memory. Recreating...`);
          if (live) {
            try {
              await live?.client?.logout('Recreate instance');
              live?.client?.ws?.close();
              live?.client?.end(undefined);
            } catch {}
            delete this.waMonitor.waInstances[instanceName];
            this.waMonitor.clearDelInstanceTime(instanceName);
          }
          if (dbInstance) {
            await this.prismaRepository.instance.delete({
              where: { id: dbInstance.id },
            }).catch(() => {});
          }

          if (this.instanceController) {
            this.logger.info(`Creating fresh instance "${instanceName}"...`);
            try {
              const created: any = await this.instanceController.createInstance({
                instanceName,
                integration: Integration.WHATSAPP_BAILEYS,
                qrcode: true,
                number: number || undefined,
              } as any);

              live = this.waMonitor.waInstances[instanceName];
              if (number && (created?.qrcode?.pairingCode || created?.qrcode?.code)) {
                return res.json(created.qrcode);
              }
              if (!number && created?.qrcode?.base64) {
                return res.json(created.qrcode);
              }
            } catch (createErr: any) {
              this.logger.error(`Error creating instance ${instanceName}: ${createErr?.message || createErr}`);
            }
          }
        }

        live = this.waMonitor.waInstances[instanceName];
        if (!live) {
          return res.status(404).json({ error: `Instance "${instanceName}" could not be loaded or created` });
        }

        const currentState = live?.connectionStatus?.state;
        if (currentState === 'open') {
          return res.json({
            count: 1,
            state: 'open',
            message: 'Instance is already connected',
          });
        }

        // Trigger connect (pass number if requested for pairing code)
        try {
          await live.connectToWhatsapp(number || undefined);
        } catch (connErr: any) {
          this.logger.warn(`connectToWhatsapp trigger warning: ${connErr?.message || connErr}`);
        }

        // Wait up to 8 seconds for QR code or Pairing Code generation
        for (let i = 0; i < 16; i++) {
          if (number && (live.qrCode?.pairingCode || live.qrCode?.code)) {
            return res.json({
              pairingCode: live.qrCode.pairingCode || live.qrCode.code,
              code: live.qrCode.pairingCode || live.qrCode.code,
            });
          }
          if (!number && (live.qrCode?.base64 || live.qrCode?.code)) {
            return res.json(live.qrCode);
          }
          if (live.connectionStatus?.state === 'open') {
            return res.json({
              count: 1,
              state: 'open',
              message: 'Instance connected successfully',
            });
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }

        if (live.qrCode?.base64 || live.qrCode?.pairingCode || live.qrCode?.code) {
          return res.json(live.qrCode);
        }

        return res.json({
          state: live.connectionStatus?.state || 'connecting',
          message: 'Code is generating. Please wait a moment and click Refresh.',
        });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    // 4c. Reset Instance Session (Clear stuck credentials and generate fresh session)
    this.router.post('/instances/:instanceName/reset', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        this.logger.info(`Resetting session for instance "${instanceName}"...`);

        // 1. Delete instance from DB (cascades to Session, IntegrationSession, Chats, etc.)
        const dbInst = await this.prismaRepository.instance.findFirst({
          where: { name: instanceName },
        });
        if (dbInst) {
          await this.prismaRepository.instance.delete({
            where: { id: dbInst.id },
          }).catch((e) => this.logger.warn(`Instance cleanup warning: ${e.message}`));
        }

        // 2. Clear instance from waMonitor and event emitter
        try {
          if (this.waMonitor.waInstances[instanceName]) {
            await this.waMonitor.waInstances[instanceName]?.client?.logout('Reset instance').catch(() => {});
            this.waMonitor.waInstances[instanceName]?.client?.ws?.close();
            this.waMonitor.waInstances[instanceName]?.client?.end(undefined);
            delete this.waMonitor.waInstances[instanceName];
            this.waMonitor.clearDelInstanceTime(instanceName);
          }
        } catch (cleanupErr: any) {
          this.logger.warn(`Memory cleanup warning: ${cleanupErr.message}`);
        }

        // 3. Re-create instance fresh
        if (this.instanceController) {
          const created: any = await this.instanceController.createInstance({
            instanceName,
            integration: Integration.WHATSAPP_BAILEYS,
            qrcode: true,
          } as any);
          return res.json({
            success: true,
            message: 'Instance session reset successfully',
            qrcode: created?.qrcode,
          });
        }

        return res.json({ success: true, message: 'Instance reset' });
      } catch (err: any) {
        return res.status(500).json({ error: err.message });
      }
    });

    // 4b. Explicitly Create Instance
    this.router.post('/instances', auth, async (req: Request, res: Response) => {
      try {
        const { name } = req.body;
        const instanceName = (name || 'default').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (!instanceName) {
          return res.status(400).json({ error: 'Valid instance name required' });
        }
        if (this.waMonitor.waInstances[instanceName]) {
          return res.json({ message: 'Instance already exists', instanceName });
        }
        if (this.instanceController) {
          const result = await this.instanceController.createInstance({
            instanceName,
            integration: Integration.WHATSAPP_BAILEYS,
            qrcode: true,
          } as any);
          return res.status(201).json(result);
        }
        return res.status(500).json({ error: 'Instance controller not available' });
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
