export interface IzchuSettings {
  stravaClientId: string;
  stravaClientSecret: string;
  ftp: number | null;
  maxHeartRate: number | null;
}

export interface StoredToken {
  athleteId: number;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  athleteName: string | null;
}

export interface WebhookSettings {
  subscriptionId: number | null;
  callbackToken: string;
  enabled: boolean;
  lastEventAt: string | null;
  lastError: string | null;
}

export interface StravaWebhookEvent {
  object_type: "activity" | "athlete";
  object_id: number;
  aspect_type: "create" | "update" | "delete";
  owner_id: number;
  subscription_id: number;
  event_time: number;
  updates?: Record<string, string | boolean>;
}

export interface StravaActivity {
  id: number;
  name: string;
  sport_type?: string;
  type?: string;
  start_date_local: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  average_speed?: number;
  max_speed?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_watts?: number;
  weighted_average_watts?: number;
  max_watts?: number;
  kilojoules?: number;
  average_cadence?: number;
  average_temp?: number;
  description?: string | null;
  device_name?: string;
}

export interface StravaStream {
  type: string;
  data: number[] | boolean[] | [number, number][];
  original_size: number;
  resolution: string;
}

export type StravaStreams = Record<string, StravaStream>;

export interface SummaryMetrics {
  distanceKm: number;
  movingMinutes: number;
  elevationGain: number;
  averageSpeedKmh: number | null;
  normalizedPower: number | null;
  intensityFactor: number | null;
  trainingStressScore: number | null;
  averageHeartRate: number | null;
  maxHeartRate: number | null;
  averageCadence: number | null;
  workKilojoules: number | null;
}

export interface GeneratedSummary {
  activityId: number;
  activityName: string;
  description: string;
  metrics: SummaryMetrics;
  source: "strava";
}
