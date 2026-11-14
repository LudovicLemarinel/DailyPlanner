"""Constants for Daily Planner."""

DOMAIN = "daily_planner"
VERSION = "0.1.0"

STORAGE_KEY = f"{DOMAIN}.schedules"
STORAGE_VERSION = 1

CARD_FILENAME = "daily-planner-card.js"
CARD_URL = f"/{DOMAIN}/{CARD_FILENAME}"

SIGNAL_SCHEDULE_ADDED = f"{DOMAIN}_schedule_added"
SIGNAL_SCHEDULE_UPDATED = f"{DOMAIN}_schedule_updated_{{}}"

EVENT_EXECUTED = f"{DOMAIN}_executed"

ATTR_TIME = "time"
ATTR_DAYS = "days"
ATTR_ACTIONS = "actions"
ATTR_NEXT_RUN = "next_run"
ATTR_LAST_RUN = "last_run"
ATTR_SCHEDULE_ID = "schedule_id"
