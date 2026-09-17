-- `"countryCode" = 'ID'` is NULL, not FALSE, when countryCode is NULL, and a CHECK only
-- rejects FALSE — so a row with a regionCode and no country slipped through. Compare with
-- IS NOT DISTINCT FROM, which is TRUE or FALSE even against NULL.
ALTER TABLE "User" DROP CONSTRAINT "User_region_only_in_id";
ALTER TABLE "User" ADD CONSTRAINT "User_region_only_in_id"
  CHECK ("regionCode" IS NULL OR "countryCode" IS NOT DISTINCT FROM 'ID');
