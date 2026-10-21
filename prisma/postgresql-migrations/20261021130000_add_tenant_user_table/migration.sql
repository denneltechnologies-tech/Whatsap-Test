-- CreateTable
CREATE TABLE IF NOT EXISTS "TenantUser" (
    "id" TEXT NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "passwordHash" VARCHAR(255) NOT NULL,
    "businessName" VARCHAR(255) NOT NULL,
    "role" VARCHAR(50) NOT NULL DEFAULT 'tenant',
    "instanceId" VARCHAR(255),
    "status" VARCHAR(50) NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL,

    CONSTRAINT "TenantUser_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TenantUser_email_key" ON "TenantUser"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TenantUser_email_idx" ON "TenantUser"("email");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TenantUser_instanceId_idx" ON "TenantUser"("instanceId");
