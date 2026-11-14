"""Switch entities: one per schedule, to enable/disable it."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from . import DailyPlannerConfigEntry
from .const import (
    ATTR_ACTIONS,
    ATTR_DAYS,
    ATTR_LAST_RUN,
    ATTR_NEXT_RUN,
    ATTR_SCHEDULE_ID,
    ATTR_TIME,
    DOMAIN,
    SIGNAL_SCHEDULE_ADDED,
    SIGNAL_SCHEDULE_UPDATED,
)
from .planner import Planner


async def async_setup_entry(
    hass: HomeAssistant,
    entry: DailyPlannerConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Create a switch for every existing and future schedule."""
    planner = entry.runtime_data
    async_add_entities(
        DailyPlannerSwitch(planner, schedule_id) for schedule_id in planner.schedules
    )

    @callback
    def _added(schedule_id: str) -> None:
        async_add_entities([DailyPlannerSwitch(planner, schedule_id)])

    entry.async_on_unload(
        async_dispatcher_connect(hass, SIGNAL_SCHEDULE_ADDED, _added)
    )


class DailyPlannerSwitch(SwitchEntity):
    """Enable / disable a schedule."""

    _attr_should_poll = False
    _attr_icon = "mdi:calendar-clock"

    def __init__(self, planner: Planner, schedule_id: str) -> None:
        self._planner = planner
        self._schedule_id = schedule_id
        self._attr_unique_id = schedule_id
        self.entity_id = f"switch.{DOMAIN}_{schedule_id}"

    @property
    def _schedule(self) -> dict[str, Any]:
        return self._planner.schedules.get(self._schedule_id, {})

    @property
    def available(self) -> bool:
        return self._schedule_id in self._planner.schedules

    @property
    def name(self) -> str:
        return self._schedule.get("name", self._schedule_id)

    @property
    def is_on(self) -> bool:
        return bool(self._schedule.get("enabled"))

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        next_run = self._planner.next_run(self._schedule_id)
        last_run = self._planner.last_runs.get(self._schedule_id)
        return {
            ATTR_SCHEDULE_ID: self._schedule_id,
            ATTR_TIME: self._schedule.get("time"),
            ATTR_DAYS: self._schedule.get("days", []),
            ATTR_ACTIONS: len(self._schedule.get("actions", [])),
            ATTR_NEXT_RUN: next_run.isoformat() if next_run else None,
            ATTR_LAST_RUN: last_run.isoformat() if last_run else None,
        }

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self._planner.async_set_enabled(self._schedule_id, True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._planner.async_set_enabled(self._schedule_id, False)

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass,
                SIGNAL_SCHEDULE_UPDATED.format(self._schedule_id),
                self.async_write_ha_state,
            )
        )
