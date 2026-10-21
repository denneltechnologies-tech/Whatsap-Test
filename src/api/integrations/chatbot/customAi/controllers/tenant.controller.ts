import { InstanceDto } from '@api/dto/instance.dto';
import { PrismaRepository } from '@api/repository/repository.service';
import { Integration } from '@api/types/wa.types';
import { Auth, ConfigService } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { BadRequestException, ForbiddenException, NotFoundException, UnauthorizedException } from '@exceptions';

import { CustomAiService } from '../services/customAi.service';
import { generateToken, hashPassword, verifyPassword } from '../utils/auth.util';

export class TenantController {
  private readonly logger = new Logger('TenantController');

  constructor(
    private readonly prismaRepository: PrismaRepository,
    private readonly customAiService: CustomAiService,
    private readonly configService: ConfigService,
    private readonly instanceController?: any,
  ) {}

  /**
   * Authenticates either a Tenant user, Super Admin, or fallback Master API key
   */
  public async login(data: { email?: string; password?: string; apiKey?: string }) {
    const globalKey = this.configService.get<Auth>('AUTHENTICATION')?.API_KEY?.KEY;

    // 1. Direct API Key authentication fallback (treated as Super Admin)
    if (data.apiKey && globalKey && data.apiKey === globalKey) {
      const token = generateToken({
        userId: 'superadmin_master',
        email: 'admin@evolution.local',
        role: 'superadmin',
        businessName: 'Master Super Admin',
      });
      return {
        token,
        user: {
          id: 'superadmin_master',
          email: 'admin@evolution.local',
          role: 'superadmin',
          businessName: 'Master Super Admin',
        },
      };
    }

    const email = data.email?.toLowerCase().trim();
    const password = data.password;

    if (!email || !password) {
      throw new BadRequestException('Email and password are required');
    }

    // 2. Check if user exists in TenantUser table
    const user = await (this.prismaRepository as any).tenantUser.findUnique({
      where: { email },
    });

    if (user) {
      if (user.status === 'suspended') {
        throw new ForbiddenException('This business account has been suspended. Please contact the administrator.');
      }

      const isValid = verifyPassword(password, user.passwordHash);
      if (!isValid) {
        throw new UnauthorizedException('Invalid email or password');
      }

      // Fetch instance name if assigned
      let instanceName: string | undefined;
      if (user.instanceId) {
        const inst = await this.prismaRepository.instance.findUnique({
          where: { id: user.instanceId },
          select: { name: true },
        });
        instanceName = inst?.name;
      }

      const token = generateToken({
        userId: user.id,
        email: user.email,
        role: user.role,
        businessName: user.businessName,
        instanceId: user.instanceId,
        instanceName,
      });

      return {
        token,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          businessName: user.businessName,
          instanceId: user.instanceId,
          instanceName,
        },
      };
    }

    // 3. Fallback: If no superadmin user has been created yet, and password matches master API key
    if (globalKey && password === globalKey) {
      // Auto-provision initial superadmin record
      const newAdmin = await (this.prismaRepository as any).tenantUser.create({
        data: {
          email,
          passwordHash: hashPassword(password),
          businessName: 'Platform Super Admin',
          role: 'superadmin',
          status: 'active',
        },
      });

      const token = generateToken({
        userId: newAdmin.id,
        email: newAdmin.email,
        role: 'superadmin',
        businessName: newAdmin.businessName,
      });

      return {
        token,
        user: {
          id: newAdmin.id,
          email: newAdmin.email,
          role: newAdmin.role,
          businessName: newAdmin.businessName,
        },
      };
    }

    throw new UnauthorizedException('Invalid email or password');
  }

  /**
   * Retrieves current authenticated profile
   */
  public async getMe(userContext: any) {
    if (!userContext || !userContext.userId) {
      throw new UnauthorizedException();
    }

    if (userContext.userId === 'superadmin_master') {
      return {
        id: 'superadmin_master',
        email: userContext.email || 'admin@evolution.local',
        role: 'superadmin',
        businessName: 'Master Super Admin',
      };
    }

    const user = await (this.prismaRepository as any).tenantUser.findUnique({
      where: { id: userContext.userId },
      select: {
        id: true,
        email: true,
        businessName: true,
        role: true,
        instanceId: true,
        status: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User profile not found');
    }

    let instanceName = userContext.instanceName;
    if (user.instanceId && !instanceName) {
      const inst = await this.prismaRepository.instance.findUnique({
        where: { id: user.instanceId },
        select: { name: true },
      });
      instanceName = inst?.name;
    }

    return {
      ...user,
      instanceName,
    };
  }

  /**
   * Lists all onboarded tenant businesses (Super Admin only)
   */
  public async listTenants() {
    const tenants = await (this.prismaRepository as any).tenantUser.findMany({
      orderBy: { createdAt: 'desc' },
    });

    const enriched = await Promise.all(
      tenants.map(async (t: any) => {
        let instance = null;
        let stats = { totalConversations: 0, totalAiReplies: 0, totalDocuments: 0 };

        if (t.instanceId) {
          instance = await this.prismaRepository.instance.findUnique({
            where: { id: t.instanceId },
            select: {
              id: true,
              name: true,
              connectionStatus: true,
              number: true,
              profileName: true,
              profilePicUrl: true,
            },
          });

          const convCount = await (this.prismaRepository as any).aiConversationState.count({
            where: { instanceId: t.instanceId },
          });

          const aiReplyCount = await (this.prismaRepository as any).aiMessageLog.count({
            where: { instanceId: t.instanceId, senderType: 'ai' },
          });

          const docCount = await (this.prismaRepository as any).knowledgeDocument.count({
            where: { instanceId: t.instanceId },
          });

          stats = {
            totalConversations: convCount,
            totalAiReplies: aiReplyCount,
            totalDocuments: docCount,
          };
        }

        return {
          id: t.id,
          businessName: t.businessName,
          email: t.email,
          role: t.role,
          status: t.status,
          instanceId: t.instanceId,
          instanceName: instance?.name,
          connectionStatus: instance?.connectionStatus || 'closed',
          whatsappNumber: instance?.number,
          stats,
          createdAt: t.createdAt,
        };
      }),
    );

    return enriched;
  }

  /**
   * Onboards a new business: creates dedicated WhatsApp instance + tenant user + default AI assistant config
   */
  public async createTenant(data: {
    businessName: string;
    email: string;
    password: string;
    instanceName?: string;
  }) {
    const businessName = data.businessName?.trim();
    const email = data.email?.toLowerCase().trim();
    const password = data.password;

    if (!businessName || !email || !password) {
      throw new BadRequestException('Business name, owner email, and password are required');
    }

    if (password.length < 6) {
      throw new BadRequestException('Password must be at least 6 characters');
    }

    // Check if email already registered
    const existingUser = await (this.prismaRepository as any).tenantUser.findUnique({
      where: { email },
    });
    if (existingUser) {
      throw new BadRequestException(`An account with email '${email}' already exists`);
    }

    // 1. Generate or validate instance name
    let cleanInstanceName = data.instanceName?.trim();
    if (!cleanInstanceName) {
      const slug = businessName
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .substring(0, 16);
      const randSuffix = Math.random().toString(36).substring(2, 6);
      cleanInstanceName = `${slug || 'biz'}_${randSuffix}`;
    }

    // Check instance name uniqueness
    let existingInst = await this.prismaRepository.instance.findUnique({
      where: { name: cleanInstanceName },
    });

    let createdInstance: any = null;

    if (!existingInst) {
      // 2. Create WhatsApp instance via instanceController or database
      if (this.instanceController && typeof this.instanceController.createInstance === 'function') {
        try {
          const instDto = new InstanceDto();
          instDto.instanceName = cleanInstanceName;
          instDto.integration = Integration.WHATSAPP_BAILEYS;
          instDto.qrcode = true;
          await this.instanceController.createInstance(instDto);
        } catch (err: any) {
          this.logger.warn(`InstanceController creation failed, falling back to direct db create: ${err.message}`);
        }
      }

      // Ensure instance exists in db
      existingInst = await this.prismaRepository.instance.findUnique({
        where: { name: cleanInstanceName },
      });

      if (!existingInst) {
        existingInst = await this.prismaRepository.instance.create({
          data: {
            name: cleanInstanceName,
            integration: Integration.WHATSAPP_BAILEYS,
            connectionStatus: 'close',
          },
        });
      }
    }

    createdInstance = existingInst;

    // 3. Create TenantUser account
    const tenantUser = await (this.prismaRepository as any).tenantUser.create({
      data: {
        email,
        passwordHash: hashPassword(password),
        businessName,
        role: 'tenant',
        instanceId: createdInstance.id,
        status: 'active',
      },
    });

    // 4. Initialize AI Assistant configuration for this business
    await this.customAiService.getOrCreateConfig(createdInstance.id);
    await this.prismaRepository.aiAssistantConfig.update({
      where: { instanceId: createdInstance.id },
      data: {
        businessName,
        assistantName: `${businessName} AI Assistant`,
      },
    });

    this.logger.info(`Successfully onboarded new business '${businessName}' with instance '${cleanInstanceName}'`);

    return {
      message: 'Business account created successfully',
      tenant: {
        id: tenantUser.id,
        businessName: tenantUser.businessName,
        email: tenantUser.email,
        instanceName: cleanInstanceName,
        instanceId: createdInstance.id,
        status: tenantUser.status,
      },
    };
  }

  /**
   * Updates tenant status or resets password
   */
  public async updateTenant(
    tenantId: string,
    data: { status?: 'active' | 'suspended'; password?: string; businessName?: string },
  ) {
    const tenant = await (this.prismaRepository as any).tenantUser.findUnique({
      where: { id: tenantId },
    });
    if (!tenant) {
      throw new NotFoundException('Tenant account not found');
    }

    const updateData: any = {};
    if (data.status) {
      updateData.status = data.status;
    }
    if (data.businessName) {
      updateData.businessName = data.businessName;
    }
    if (data.password) {
      if (data.password.length < 6) {
        throw new BadRequestException('Password must be at least 6 characters');
      }
      updateData.passwordHash = hashPassword(data.password);
    }

    const updated = await (this.prismaRepository as any).tenantUser.update({
      where: { id: tenantId },
      data: updateData,
    });

    return {
      message: 'Tenant account updated successfully',
      tenant: {
        id: updated.id,
        email: updated.email,
        businessName: updated.businessName,
        status: updated.status,
      },
    };
  }

  /**
   * Deletes a tenant account
   */
  public async deleteTenant(tenantId: string) {
    const tenant = await (this.prismaRepository as any).tenantUser.findUnique({
      where: { id: tenantId },
    });
    if (!tenant) {
      throw new NotFoundException('Tenant account not found');
    }

    await (this.prismaRepository as any).tenantUser.delete({
      where: { id: tenantId },
    });

    return { message: `Business account '${tenant.businessName}' deleted successfully` };
  }
}
