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
import { TenantController } from '../controllers/tenant.controller';
import { verifyToken } from '../utils/auth.util';

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
    private readonly tenantController?: TenantController,
  ) {
    this.router = Router();
    this.initRoutes();
  }

  /**
   * Unified Authentication Guard:
   * Accepts:
   * 1. 'apikey' header matching AUTHENTICATION_API_KEY
   * 2. 'Authorization: Bearer <token>' matching AUTHENTICATION_API_KEY, CUSTOM_AI_ADMIN_PASSWORD, or signed JWT
   * Enforces multi-tenant instance isolation:
   * - If user is a tenant, they can ONLY access routes for their assigned instanceName!
   * - If user is a superadmin, they can access any instance.
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

      // 1. Direct master key authentication (Super Admin)
      if (token && ((globalKey && token === globalKey) || (adminPassword && token === adminPassword))) {
        (req as any).user = {
          userId: 'superadmin_master',
          role: 'superadmin',
          email: 'admin@evolution.local',
        };
        return next();
      }

      // 2. JWT Token verification
      if (bearerToken) {
        const decoded = verifyToken(bearerToken);
        if (decoded && decoded.userId) {
          (req as any).user = decoded;

          // Multi-tenant instance isolation check
          if (decoded.role === 'tenant' && decoded.instanceName) {
            const requestedInstance =
              req.params.instanceName || (req.query.instanceName as string) || req.body?.instanceName;

            // If a specific instance is targeted, ensure it matches the tenant's instance
            if (requestedInstance && requestedInstance !== decoded.instanceName) {
              return res.status(403).json({
                error: 'Forbidden: You do not have permission to access or modify this business instance',
              });
            }
          }

          return next();
        }
      }

      // 3. Fallback for unconfigured local development
      if (!globalKey && !adminPassword) {
        (req as any).user = { role: 'superadmin' };
        return next();
      }

      return res.status(401).json({ error: 'Unauthorized: Invalid or missing authentication token' });
    };
  }

  /**
   * Superadmin-only guard for tenant management
   */
  private superAdminOnly(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      const user = (req as any).user;
      if (!user || user.role !== 'superadmin') {
        return res.status(403).json({ error: 'Forbidden: Super Admin privileges required' });
      }
      return next();
    };
  }

  private initRoutes() {
    const auth = this.adminAuthMiddleware();
    const superAdmin = this.superAdminOnly();

    // 1a. User Login (Email/Password or API Key)
    this.router.post('/auth/login', async (req: Request, res: Response) => {
      try {
        if (!this.tenantController) {
          return res.status(500).json({ error: 'Tenant controller not initialized' });
        }
        const result = await this.tenantController.login(req.body);
        return res.json(result);
      } catch (err: any) {
        return res.status(err.status || 401).json({ error: err.message });
      }
    });

    // 1b. Current Authenticated Profile
    this.router.get('/auth/me', auth, async (req: Request, res: Response) => {
      try {
        if (!this.tenantController) {
          return res.status(500).json({ error: 'Tenant controller not initialized' });
        }
        const profile = await this.tenantController.getMe((req as any).user);
        return res.json(profile);
      } catch (err: any) {
        return res.status(err.status || 401).json({ error: err.message });
      }
    });

    // 1c. Legacy Auth check endpoint
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

    // 1d. Multi-Tenant Business Management (Super Admin Only)
    this.router.get('/admin/tenants', auth, superAdmin, async (req: Request, res: Response) => {
      try {
        if (!this.tenantController) {
          return res.status(500).json({ error: 'Tenant controller not initialized' });
        }
        const list = await this.tenantController.listTenants();
        return res.json(list);
      } catch (err: any) {
        return res.status(err.status || 500).json({ error: err.message });
      }
    });

    this.router.post('/admin/tenants', auth, superAdmin, async (req: Request, res: Response) => {
      try {
        if (!this.tenantController) {
          return res.status(500).json({ error: 'Tenant controller not initialized' });
        }
        const created = await this.tenantController.createTenant(req.body);
        return res.status(201).json(created);
      } catch (err: any) {
        return res.status(err.status || 400).json({ error: err.message });
      }
    });

    this.router.patch('/admin/tenants/:id', auth, superAdmin, async (req: Request, res: Response) => {
      try {
        if (!this.tenantController) {
          return res.status(500).json({ error: 'Tenant controller not initialized' });
        }
        const updated = await this.tenantController.updateTenant(req.params.id, req.body);
        return res.json(updated);
      } catch (err: any) {
        return res.status(err.status || 400).json({ error: err.message });
      }
    });

    this.router.delete('/admin/tenants/:id', auth, superAdmin, async (req: Request, res: Response) => {
      try {
        if (!this.tenantController) {
          return res.status(500).json({ error: 'Tenant controller not initialized' });
        }
        const deleted = await this.tenantController.deleteTenant(req.params.id);
        return res.json(deleted);
      } catch (err: any) {
        return res.status(err.status || 400).json({ error: err.message });
      }
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

        // If requester is a tenant user, restrict instances list to only their assigned instance
        const user = (req as any).user;
        if (user && user.role === 'tenant' && user.instanceName) {
          enriched = enriched.filter((i) => i.name === user.instanceName);
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
        if (!dbInstance) {
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
        } else if (!live) {
          this.logger.info(`Instance "${instanceName}" found in DB but not active in memory. Loading...`);
          if (this.instanceController) {
            try {
              await this.instanceController.createInstance({
                instanceName: dbInstance.name,
                integration: dbInstance.integration || Integration.WHATSAPP_BAILEYS,
                qrcode: true,
                number: number || undefined,
              } as any);
              live = this.waMonitor.waInstances[instanceName];
            } catch (loadErr: any) {
              this.logger.warn(`Could not load instance into memory: ${loadErr?.message || loadErr}`);
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

        // Only trigger connectToWhatsapp if instance is closed or if pairing number was explicitly requested
        const needsConnect = currentState === 'close' || 
          (number && !live.qrCode?.pairingCode) || 
          (!number && !live.qrCode?.base64 && currentState !== 'connecting');

        if (needsConnect) {
          try {
            await live.connectToWhatsapp(number || undefined);
          } catch (connErr: any) {
            this.logger.warn(`connectToWhatsapp trigger warning: ${connErr?.message || connErr}`);
          }
        }

        // Wait up to 6 seconds for QR code or Pairing Code generation
        for (let i = 0; i < 12; i++) {
          if (number && (live.qrCode?.pairingCode || live.qrCode?.code)) {
            return res.json({
              pairingCode: live.qrCode.pairingCode || live.qrCode.code,
              code: live.qrCode.pairingCode || live.qrCode.code,
              count: live.qrCode.count,
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

    // 4d. Disconnect / Logout WhatsApp Session (Allows user to disconnect current number & connect a different one)
    this.router.post('/instances/:instanceName/logout', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        this.logger.info(`Disconnecting/logging out WhatsApp for instance "${instanceName}"...`);

        // 1. If active in waMonitor, call logoutInstance() to cleanly disconnect socket and wipe credentials
        try {
          const live = this.waMonitor.waInstances[instanceName];
          if (live) {
            await live.logoutInstance().catch((err: any) => {
              this.logger.warn(`logoutInstance error for ${instanceName}: ${err?.message || err}`);
            });
            try {
              live.client?.ws?.close();
            } catch (_) {}
            live.qrCode = null;
          }
        } catch (e: any) {
          this.logger.warn(`waMonitor logout error: ${e.message}`);
        }

        // 2. Also try controller logout if available
        if (this.instanceController) {
          try {
            await this.instanceController.logout({ instanceName } as any).catch(() => {});
          } catch (_) {}
        }

        // 3. Update DB instance state to 'close' and clear the connected phone number & profile
        await this.prismaRepository.instance.updateMany({
          where: { name: instanceName },
          data: {
            connectionStatus: 'close',
            number: null,
            profileName: null,
            profilePicUrl: null,
          },
        }).catch(() => {});

        return res.json({
          success: true,
          message: 'WhatsApp number disconnected successfully. You can now connect a new number.',
        });
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

    this.router.post('/settings/:instanceName/test-notification', auth, async (req: Request, res: Response) => {
      try {
        const { instanceName } = req.params;
        const response = await this.settingsController.testNotification(instanceName, req.body);
        return res.json(response);
      } catch (err: any) {
        return res.status(err.status || 500).json({ error: err.message });
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
