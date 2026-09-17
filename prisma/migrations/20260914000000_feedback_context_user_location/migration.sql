-- AlterTable
ALTER TABLE "Feedback" ADD COLUMN     "lang" TEXT,
ADD COLUMN     "partnerUserId" TEXT,
ADD COLUMN     "sessionMode" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "cityName" TEXT,
ADD COLUMN     "countryCode" TEXT,
ADD COLUMN     "regionCode" TEXT;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_partnerUserId_fkey" FOREIGN KEY ("partnerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A location is one of three shapes: none, an Indonesian region, or a country abroad
-- with an optional city. Prisma can't express these, so they live here, where no write
-- path (a route, a script, an admin console) can store a mixed state.
ALTER TABLE "User" ADD CONSTRAINT "User_region_only_in_id"
  CHECK ("regionCode" IS NULL OR "countryCode" = 'ID');
ALTER TABLE "User" ADD CONSTRAINT "User_id_needs_region"
  CHECK ("countryCode" IS DISTINCT FROM 'ID' OR "regionCode" IS NOT NULL);
ALTER TABLE "User" ADD CONSTRAINT "User_city_only_abroad"
  CHECK ("cityName" IS NULL OR ("countryCode" IS NOT NULL AND "countryCode" <> 'ID'));
