-- CreateTable
CREATE TABLE "Buddy" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "buddyId" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Buddy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Buddy_buddyId_fkey" FOREIGN KEY ("buddyId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Buddy_userId_idx" ON "Buddy"("userId");

-- CreateIndex
CREATE INDEX "Buddy_buddyId_idx" ON "Buddy"("buddyId");

-- CreateIndex
CREATE UNIQUE INDEX "Buddy_userId_buddyId_key" ON "Buddy"("userId", "buddyId");
