-- Trigram matching for the admin user search. Prisma doesn't manage extensions
-- here (no `postgresqlExtensions` preview feature), so it's created by hand.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "User_username_idx" ON "User" USING GIN ("username" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "User_displayName_idx" ON "User" USING GIN ("displayName" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User" USING GIN ("email" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Feedback_userId_idx" ON "Feedback"("userId");
