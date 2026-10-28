-- Run once: npx wrangler d1 execute booking-db --file=schema.sql --remote
CREATE TABLE IF NOT EXISTS bookings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  start_utc   TEXT NOT NULL,              -- ISO time in UTC
  duration    INTEGER NOT NULL DEFAULT 30,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  whatsapp    TEXT,
  method      TEXT NOT NULL,              -- Google Meet / Zoom / WhatsApp call
  topic       TEXT,
  client_tz   TEXT,                       -- visitor's time zone, for their emails
  meet_link   TEXT,                       -- add later; included in reminders
  status      TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed / done / cancelled
  r24         INTEGER NOT NULL DEFAULT 0, -- 24h reminder sent
  r1          INTEGER NOT NULL DEFAULT 0  -- 1h reminder sent
);
-- Two people can never hold the same confirmed slot
CREATE UNIQUE INDEX IF NOT EXISTS one_booking_per_slot ON bookings(start_utc) WHERE status = 'confirmed';
CREATE INDEX IF NOT EXISTS by_email ON bookings(email, created_at);
