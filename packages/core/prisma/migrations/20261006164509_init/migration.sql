-- Ekstensi pgvector WAJIB aktif sebelum tabel berisi kolom vector(1536) dibuat.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "ProviderSlot" AS ENUM ('chat', 'embedding', 'vision', 'transcription');

-- CreateEnum
CREATE TYPE "ContactTag" AS ENUM ('Lead', 'Internal');

-- CreateEnum
CREATE TYPE "ChatMode" AS ENUM ('full', 'semi', 'off');

-- CreateEnum
CREATE TYPE "MessageSource" AS ENUM ('wa', 'phone', 'dashboard', 'ai');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('pending', 'approved', 'rejected', 'edited');

-- CreateEnum
CREATE TYPE "HandoffStatus" AS ENUM ('open', 'resumed', 'closed');

-- CreateEnum
CREATE TYPE "KnowledgeType" AS ENUM ('text', 'url', 'pdf', 'image');

-- CreateEnum
CREATE TYPE "KnowledgeStatus" AS ENUM ('processing', 'ready', 'failed');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('brosur', 'pricelist', 'siteplan', 'foto', 'lainnya');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('kpr', 'cash', 'unknown');

-- CreateEnum
CREATE TYPE "LeadEventType" AS ENUM ('stage', 'score', 'note');

-- CreateEnum
CREATE TYPE "FollowUpStage" AS ENUM ('h1', 'h3', 'h7', 'h14');

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('scheduled', 'sent', 'cancelled', 'skipped');

-- CreateEnum
CREATE TYPE "ExampleSource" AS ENUM ('draft_edit', 'manual_reply');

-- CreateEnum
CREATE TYPE "UnitStatus" AS ENUM ('tersedia', 'terbatas', 'habis');

-- CreateTable
CREATE TABLE "Admin" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "totpSecret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Admin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "slot" "ProviderSlot" NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKeySettingKey" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "pn" TEXT NOT NULL,
    "lid" TEXT,
    "tag" "ContactTag" NOT NULL DEFAULT 'Lead',
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chat" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "modeOverride" "ChatMode",
    "aiPaused" BOOLEAN NOT NULL DEFAULT false,
    "pausedUntil" TIMESTAMP(3),
    "ignored" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "waMessageId" TEXT,
    "fromMe" BOOLEAN NOT NULL,
    "body" TEXT,
    "mediaType" TEXT,
    "mediaPath" TEXT,
    "source" "MessageSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Draft" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "DraftStatus" NOT NULL DEFAULT 'pending',
    "confidence" DOUBLE PRECISION,
    "reason" TEXT,
    "sourcesUsed" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Handoff" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "summary" TEXT,
    "status" "HandoffStatus" NOT NULL DEFAULT 'open',
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Handoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeItem" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "type" "KnowledgeType" NOT NULL,
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'processing',
    "category" TEXT,
    "validUntil" TIMESTAMP(3),
    "sourceUri" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "section" TEXT,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "description" TEXT,
    "kind" "AssetKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadProfile" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "name" TEXT,
    "budgetMin" BIGINT,
    "budgetMax" BIGINT,
    "tipeIncaran" TEXT,
    "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'unknown',
    "dpPercent" DOUBLE PRECISION,
    "domisili" TEXT,
    "timeline" TEXT,
    "keberatan" TEXT,
    "summary" TEXT,
    "manualOverride" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadEvent" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "type" "LeadEventType" NOT NULL,
    "from" TEXT,
    "to" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "stage" "FollowUpStage" NOT NULL,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'scheduled',
    "bodyText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamplePair" (
    "id" TEXT NOT NULL,
    "leadQuestion" TEXT NOT NULL,
    "correctedAnswer" TEXT NOT NULL,
    "embedding" vector(1536),
    "source" "ExampleSource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExamplePair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Playbook" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "triggerIntent" TEXT NOT NULL,
    "bodyMarkdown" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Playbook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitType" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lt" DOUBLE PRECISION NOT NULL,
    "lb" DOUBLE PRECISION NOT NULL,
    "kt" INTEGER NOT NULL,
    "km" INTEGER NOT NULL,
    "price" BIGINT NOT NULL,
    "status" "UnitStatus" NOT NULL DEFAULT 'tersedia',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnitType_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Admin_email_key" ON "Admin"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Setting_key_key" ON "Setting"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Provider_slot_name_key" ON "Provider"("slot", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_pn_key" ON "Contact"("pn");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_lid_key" ON "Contact"("lid");

-- CreateIndex
CREATE UNIQUE INDEX "Chat_contactId_key" ON "Chat"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_waMessageId_key" ON "Message"("waMessageId");

-- CreateIndex
CREATE INDEX "Message_chatId_createdAt_idx" ON "Message"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "Draft_chatId_createdAt_idx" ON "Draft"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "Handoff_chatId_status_idx" ON "Handoff"("chatId", "status");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_itemId_idx" ON "KnowledgeChunk"("itemId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunk_itemId_chunkIndex_key" ON "KnowledgeChunk"("itemId", "chunkIndex");

-- CreateIndex
CREATE INDEX "Asset_kind_idx" ON "Asset"("kind");

-- CreateIndex
CREATE INDEX "Asset_tag_idx" ON "Asset"("tag");

-- CreateIndex
CREATE UNIQUE INDEX "LeadProfile_contactId_key" ON "LeadProfile"("contactId");

-- CreateIndex
CREATE INDEX "LeadEvent_contactId_createdAt_idx" ON "LeadEvent"("contactId", "createdAt");

-- CreateIndex
CREATE INDEX "FollowUp_status_scheduledAt_idx" ON "FollowUp"("status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "Playbook_slug_key" ON "Playbook"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "UnitType_code_key" ON "UnitType"("code");

-- AddForeignKey
ALTER TABLE "Provider" ADD CONSTRAINT "Provider_apiKeySettingKey_fkey" FOREIGN KEY ("apiKeySettingKey") REFERENCES "Setting"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Draft" ADD CONSTRAINT "Draft_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Handoff" ADD CONSTRAINT "Handoff_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "KnowledgeItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadProfile" ADD CONSTRAINT "LeadProfile_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadEvent" ADD CONSTRAINT "LeadEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
