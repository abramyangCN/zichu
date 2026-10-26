ALTER TABLE settings
ADD COLUMN weather_enabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS activity_weather (
  activity_id INTEGER PRIMARY KEY,
  observed_at TEXT NOT NULL,
  temperature_c REAL NOT NULL,
  apparent_temperature_c REAL,
  precipitation_mm REAL,
  wind_speed_kmh REAL,
  wind_direction_degrees REAL,
  weather_code INTEGER,
  source TEXT NOT NULL DEFAULT 'open-meteo',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
