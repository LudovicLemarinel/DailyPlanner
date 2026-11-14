"""Schedule storage and execution for Daily Planner."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta
import logging
import re
from typing import Any

import voluptuous as vol

from homeassistant.core import CALLBACK_TYPE, Context, HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
import homeassistant.helpers.config_validation as cv
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_time_change
from homeassistant.helpers.script import Script, async_validate_actions_config
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import (
    DOMAIN,
    EVENT_EXECUTED,
    SIGNAL_SCHEDULE_ADDED,
    SIGNAL_SCHEDULE_UPDATED,
    STORAGE_KEY,
    STORAGE_VERSION,
)

_LOGGER = logging.getLogger(__name__)

TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
SCHEDULE_ID_RE = re.compile(r"^[a-z0-9_]{1,64}$")


def valid_time(value: Any) -> str:
    """Validate a HH:MM string."""
    value = cv.string(value)
    if not TIME_RE.match(value):
        raise vol.Invalid("time must be HH:MM")
    return value


def valid_schedule_id(value: Any) -> str:
    """Validate a schedule id (lowercase slug)."""
    value = cv.string(value)
    if not SCHEDULE_ID_RE.match(value):
        raise vol.Invalid("schedule_id must match [a-z0-9_]{1,64}")
    return value


SCHEDULE_FIELDS = {
    vol.Optional("name"): cv.string,
    vol.Optional("enabled"): cv.boolean,
    vol.Optional("time"): valid_time,
    vol.Optional("days"): vol.All(
        cv.ensure_list, [vol.All(vol.Coerce(int), vol.Range(min=0, max=6))]
    ),
    vol.Optional("actions"): vol.All(cv.ensure_list, [dict]),
}

DEFAULT_SCHEDULE = {
    "name": "Programme",
    "enabled": True,
    "time": "07:00",
    "days": [0, 1, 2, 3, 4],
    "actions": [],
}


class Planner:
    """Holds every schedule, persists them and fires their actions."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self.schedules: dict[str, dict[str, Any]] = {}
        self.last_runs: dict[str, datetime] = {}
        self._timers: dict[str, CALLBACK_TYPE] = {}
        self._scripts: dict[str, Script] = {}

    # ------------------------------------------------------------------ setup
    async def async_load(self) -> None:
        """Load schedules from storage and arm their timers."""
        data = await self._store.async_load() or {}
        self.schedules = data.get("schedules", {})
        for schedule_id in list(self.schedules):
            await self._async_arm(schedule_id)

    @callback
    def async_unload(self) -> None:
        """Cancel every timer."""
        for unsub in self._timers.values():
            unsub()
        self._timers.clear()
        self._scripts.clear()

    async def _async_save(self) -> None:
        await self._store.async_save({"schedules": self.schedules})

    # ------------------------------------------------------------------ CRUD
    def get(self, schedule_id: str) -> dict[str, Any] | None:
        """Return a copy of a schedule, with computed fields."""
        schedule = self.schedules.get(schedule_id)
        if schedule is None:
            return None
        result = deepcopy(schedule)
        result["id"] = schedule_id
        next_run = self.next_run(schedule_id)
        result["next_run"] = next_run.isoformat() if next_run else None
        last_run = self.last_runs.get(schedule_id)
        result["last_run"] = last_run.isoformat() if last_run else None
        result["entity_id"] = self.entity_id(schedule_id)
        return result

    def entity_id(self, schedule_id: str) -> str | None:
        """Return the switch entity id bound to a schedule."""
        return er.async_get(self.hass).async_get_entity_id("switch", DOMAIN, schedule_id)

    async def async_save_schedule(
        self, schedule_id: str, changes: dict[str, Any]
    ) -> dict[str, Any]:
        """Create or update a schedule. Raises HomeAssistantError on bad actions."""
        is_new = schedule_id not in self.schedules
        schedule = deepcopy(self.schedules.get(schedule_id, DEFAULT_SCHEDULE))
        schedule.update(changes)
        schedule["days"] = sorted(set(schedule["days"]))

        # Validate the actions before storing them (raises on error).
        await self._async_build_script(schedule_id, schedule)

        self.schedules[schedule_id] = schedule
        await self._async_save()
        await self._async_arm(schedule_id)

        if is_new:
            async_dispatcher_send(self.hass, SIGNAL_SCHEDULE_ADDED, schedule_id)
        else:
            async_dispatcher_send(
                self.hass, SIGNAL_SCHEDULE_UPDATED.format(schedule_id)
            )
        return self.get(schedule_id)  # type: ignore[return-value]

    async def async_set_enabled(self, schedule_id: str, enabled: bool) -> None:
        """Turn a schedule on or off."""
        if schedule_id not in self.schedules:
            raise HomeAssistantError(f"Unknown schedule {schedule_id}")
        self.schedules[schedule_id]["enabled"] = enabled
        await self._async_save()
        async_dispatcher_send(self.hass, SIGNAL_SCHEDULE_UPDATED.format(schedule_id))

    async def async_delete(self, schedule_id: str) -> None:
        """Delete a schedule and its switch entity."""
        if schedule_id not in self.schedules:
            raise HomeAssistantError(f"Unknown schedule {schedule_id}")
        self._disarm(schedule_id)
        del self.schedules[schedule_id]
        self.last_runs.pop(schedule_id, None)
        await self._async_save()
        ent_reg = er.async_get(self.hass)
        if entity_id := ent_reg.async_get_entity_id("switch", DOMAIN, schedule_id):
            ent_reg.async_remove(entity_id)

    # -------------------------------------------------------------- execution
    async def _async_build_script(
        self, schedule_id: str, schedule: dict[str, Any]
    ) -> Script:
        try:
            sequence = cv.SCRIPT_SCHEMA(deepcopy(schedule["actions"]))
            sequence = await async_validate_actions_config(self.hass, sequence)
        except vol.Invalid as err:
            raise HomeAssistantError(f"Invalid action: {err}") from err
        return Script(
            self.hass,
            sequence,
            f"Daily Planner: {schedule.get('name', schedule_id)}",
            DOMAIN,
            script_mode="parallel",
            max_runs=10,
            logger=_LOGGER,
        )

    def _disarm(self, schedule_id: str) -> None:
        if unsub := self._timers.pop(schedule_id, None):
            unsub()
        self._scripts.pop(schedule_id, None)

    async def _async_arm(self, schedule_id: str) -> None:
        self._disarm(schedule_id)
        schedule = self.schedules[schedule_id]
        try:
            self._scripts[schedule_id] = await self._async_build_script(
                schedule_id, schedule
            )
        except HomeAssistantError as err:
            _LOGGER.error("Schedule %s has invalid actions: %s", schedule_id, err)
            return

        hour, minute = (int(part) for part in schedule["time"].split(":"))

        @callback
        def _on_time(now: datetime) -> None:
            current = self.schedules.get(schedule_id)
            if not current or not current.get("enabled"):
                return
            if dt_util.as_local(now).weekday() not in current.get("days", []):
                return
            self.hass.async_create_task(
                self.async_run(schedule_id), f"{DOMAIN} run {schedule_id}"
            )

        self._timers[schedule_id] = async_track_time_change(
            self.hass, _on_time, hour=hour, minute=minute, second=0
        )

    async def async_run(self, schedule_id: str) -> None:
        """Run the actions of a schedule now."""
        script = self._scripts.get(schedule_id)
        if script is None:
            raise HomeAssistantError(f"Schedule {schedule_id} has no valid actions")
        self.last_runs[schedule_id] = dt_util.now()
        self.hass.bus.async_fire(
            EVENT_EXECUTED,
            {"schedule_id": schedule_id, "name": self.schedules[schedule_id]["name"]},
        )
        async_dispatcher_send(self.hass, SIGNAL_SCHEDULE_UPDATED.format(schedule_id))
        try:
            await script.async_run(context=Context())
        except Exception:  # noqa: BLE001 - never let a user action crash the planner
            _LOGGER.exception("Error while running schedule %s", schedule_id)

    def next_run(self, schedule_id: str) -> datetime | None:
        """Return the next trigger datetime of a schedule (or None)."""
        schedule = self.schedules.get(schedule_id)
        if not schedule or not schedule.get("enabled") or not schedule.get("days"):
            return None
        hour, minute = (int(part) for part in schedule["time"].split(":"))
        now = dt_util.now()
        for offset in range(8):
            day = now + timedelta(days=offset)
            candidate = day.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if candidate > now and candidate.weekday() in schedule["days"]:
                return candidate
        return None
