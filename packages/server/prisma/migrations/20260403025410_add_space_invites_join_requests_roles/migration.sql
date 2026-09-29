-- CreateTable
CREATE TABLE "SpaceInvite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "spaceId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdById" INTEGER NOT NULL,
    "maxUses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpaceInvite_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SpaceJoinRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "spaceId" TEXT NOT NULL,
    "requesterId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewedById" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME,
    CONSTRAINT "SpaceJoinRequest_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SpaceJoinRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SpaceMember" (
    "spaceId" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY ("spaceId", "userId"),
    CONSTRAINT "SpaceMember_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SpaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_SpaceMember" ("joinedAt", "spaceId", "userId") SELECT "joinedAt", "spaceId", "userId" FROM "SpaceMember";
DROP TABLE "SpaceMember";
ALTER TABLE "new_SpaceMember" RENAME TO "SpaceMember";
CREATE UNIQUE INDEX "SpaceMember_spaceId_userId_key" ON "SpaceMember"("spaceId", "userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "SpaceInvite_code_key" ON "SpaceInvite"("code");

-- CreateIndex
CREATE INDEX "SpaceInvite_spaceId_idx" ON "SpaceInvite"("spaceId");

-- CreateIndex
CREATE INDEX "SpaceInvite_code_idx" ON "SpaceInvite"("code");

-- CreateIndex
CREATE INDEX "SpaceJoinRequest_spaceId_status_idx" ON "SpaceJoinRequest"("spaceId", "status");

-- CreateIndex
CREATE INDEX "SpaceJoinRequest_requesterId_status_idx" ON "SpaceJoinRequest"("requesterId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SpaceJoinRequest_spaceId_requesterId_key" ON "SpaceJoinRequest"("spaceId", "requesterId");
