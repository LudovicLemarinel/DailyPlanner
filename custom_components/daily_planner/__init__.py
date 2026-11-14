"""Daily Planner: schedule actions at a time of day on chosen weekdays."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
import homeassistant.helpers.config_validation as cv
from homeassistant.helpers.typing import ConfigType

from .const import CARD_FILENAME, CARD_URL, DOMAIN, VERSION
from .planner import SCHEDULE_FIELDS, Planner, valid_schedule_id

PLATFORMS = [Platform.SWITCH]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type DailyPlannerConfigEntry = ConfigEntry[Planner]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Serve the Lovelace card and register the websocket API (once)."""
    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(
                CARD_URL,
                str(Path(__file__).parent / "frontend" / CARD_FILENAME),
                cache_headers=False,
            )
        ]
    )
    add_extra_js_url(hass, f"{CARD_URL}?v={VERSION}")

    for command in (ws_list, ws_get, ws_save, ws_delete, ws_run):
        websocket_api.async_register_command(hass, command)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: DailyPlannerConfigEntry) -> bool:
    """Load schedules and create switch entities."""
    planner = Planner(hass)
    await planner.async_load()
    entry.runtime_data = planner
    hass.data[DOMAIN] = planner
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: DailyPlannerConfigEntry) -> bool:
    """Unload the integration."""
    unloaded = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unloaded:
        entry.runtime_data.async_unload()
        hass.data.pop(DOMAIN, None)
    return unloaded


# ---------------------------------------------------------------- websocket API
def _planner(hass: HomeAssistant) -> Planner:
    planner = hass.data.get(DOMAIN)
    if planner is None:
        raise HomeAssistantError(
            "Daily Planner is not set up: add the integration in Settings > Devices & services"
        )
    return planner


def _handle_errors(func):
    """Turn HomeAssistantError into a websocket error message."""

    async def wrapper(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
        try:
            await func(hass, connection, msg)
        except HomeAssistantError as err:
            connection.send_error(msg["id"], "daily_planner_error", str(err))

    return wrapper


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/list"})
@websocket_api.async_response
@_handle_errors
async def ws_list(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """List every schedule."""
    planner = _planner(hass)
    connection.send_result(
        msg["id"], [planner.get(schedule_id) for schedule_id in planner.schedules]
    )


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/get",
        vol.Required("schedule_id"): valid_schedule_id,
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_get(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """Return one schedule (null if it does not exist yet)."""
    connection.send_result(msg["id"], _planner(hass).get(msg["schedule_id"]))


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/save",
        vol.Required("schedule_id"): valid_schedule_id,
        **SCHEDULE_FIELDS,
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_save(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """Create or update a schedule."""
    changes = {
        key: value
        for key, value in msg.items()
        if key not in ("id", "type", "schedule_id")
    }
    result = await _planner(hass).async_save_schedule(msg["schedule_id"], changes)
    connection.send_result(msg["id"], result)


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/delete",
        vol.Required("schedule_id"): valid_schedule_id,
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_delete(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """Delete a schedule."""
    await _planner(hass).async_delete(msg["schedule_id"])
    connection.send_result(msg["id"])


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/run",
        vol.Required("schedule_id"): valid_schedule_id,
    }
)
@websocket_api.async_response
@_handle_errors
async def ws_run(hass: HomeAssistant, connection, msg: dict[str, Any]) -> None:
    """Run a schedule's actions immediately (test button)."""
    planner = _planner(hass)
    if msg["schedule_id"] not in planner.schedules:
        raise HomeAssistantError("Unknown schedule")
    hass.async_create_task(planner.async_run(msg["schedule_id"]))
    connection.send_result(msg["id"])
