-- /api/files resolves a user-owned asset with
-- findFirst({ where: { userId, url: key } }), one lookup per asset a gallery
-- page renders (~60 per page). Only (userId, createdAt) was indexed, so the url
-- predicate was a filter over every row the user owns instead of a lookup —
-- the same reason Template carries an index on the column /api/files matches.
CREATE INDEX "Image_userId_url_idx" ON "Image"("userId", "url");
