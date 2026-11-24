CREATE UNIQUE INDEX IF NOT EXISTS "jornada_one_open_idx" ON "jornada"("status") WHERE "status" = 'OPEN';
