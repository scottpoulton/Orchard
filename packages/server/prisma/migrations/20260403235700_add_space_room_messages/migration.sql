-- CreateTable
CREATE TABLE "SpaceRoomMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "spaceId" TEXT NOT NULL,
    "senderId" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SpaceRoomMessage_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "SpaceRoomMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SpaceRoomMessage_spaceId_createdAt_idx" ON "SpaceRoomMessage"("spaceId", "createdAt");

-- CreateIndex
CREATE INDEX "SpaceRoomMessage_senderId_createdAt_idx" ON "SpaceRoomMessage"("senderId", "createdAt");
