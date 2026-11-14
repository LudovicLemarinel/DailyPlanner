"""Tests for Daily Planner."""

from datetime import datetime
from unittest.mock import AsyncMock, patch

from freezegun.api import FrozenDateTimeFactory
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_fire_time_changed,
    async_mock_service,
)

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component
from homeassistant.util import dt as dt_util

from custom_components.daily_planner.const import DOMAIN


async def _setup(hass: HomeAssistant) -> MockConfigEntry:
    """Set up the integration; frontend/http are stubbed (no hass_frontend in tests)."""
    assert await async_setup_component(hass, "http", {})
    hass.config.components.add("frontend")
    entry = MockConfigEntry(domain=DOMAIN)
    entry.add_to_hass(hass)
    with (
        patch("custom_components.daily_planner.add_extra_js_url") as add_js,
        patch.object(hass.http, "async_register_static_paths", AsyncMock()) as static,
    ):
        assert await hass.config_entries.async_setup(entry.entry_id)
        await hass.async_block_till_done()
    add_js.assert_called_once()
    static.assert_awaited_once()
    return entry


async def test_save_toggle_fire_delete(
    hass: HomeAssistant, hass_ws_client, freezer: FrozenDateTimeFactory
) -> None:
    """Full lifecycle: create, fire on the right day only, toggle, delete."""
    await hass.config.async_set_time_zone("Europe/Paris")
    calls = async_mock_service(hass, "light", "turn_on")
    await _setup(hass)
    client = await hass_ws_client(hass)
    # Monday 2026-11-16 06:59:00 local
    freezer.move_to(dt_util.as_utc(datetime(2026, 11, 16, 6, 59, 0, tzinfo=dt_util.get_time_zone("Europe/Paris"))))

    await client.send_json_auto_id({"type": "daily_planner/get", "schedule_id": "matin"})
    assert (await client.receive_json())["result"] is None

    await client.send_json_auto_id(
        {
            "type": "daily_planner/save",
            "schedule_id": "matin",
            "name": "Réveil",
            "time": "07:00",
            "days": [0, 2],
            "actions": [
                {"action": "light.turn_on", "target": {"entity_id": ["light.salon"]}, "data": {"brightness_pct": 40}}
            ],
        }
    )
    msg = await client.receive_json()
    assert msg["success"], msg
    assert msg["result"]["entity_id"] == "switch.daily_planner_matin"
    assert msg["result"]["next_run"].startswith("2026-11-16T07:00:00")
    await hass.async_block_till_done()

    state = hass.states.get("switch.daily_planner_matin")
    assert state.state == "on"
    assert state.name == "Réveil"
    assert state.attributes["days"] == [0, 2]

    # Monday 07:00 -> fires
    freezer.tick(60)
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert len(calls) == 1
    assert calls[0].data == {"entity_id": ["light.salon"], "brightness_pct": 40}

    # Tuesday 07:00 -> not a selected day
    freezer.move_to(dt_util.as_utc(datetime(2026, 11, 17, 7, 0, 0, tzinfo=dt_util.get_time_zone("Europe/Paris"))))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert len(calls) == 1

    # Disable via the switch, Wednesday 07:00 -> nothing
    await hass.services.async_call("switch", "turn_off", {"entity_id": "switch.daily_planner_matin"}, blocking=True)
    assert hass.states.get("switch.daily_planner_matin").state == "off"
    freezer.move_to(dt_util.as_utc(datetime(2026, 11, 18, 7, 0, 0, tzinfo=dt_util.get_time_zone("Europe/Paris"))))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert len(calls) == 1

    # Re-enable, change time to 08:15, Wednesday 08:15 -> fires
    planner = hass.data[DOMAIN]
    await hass.services.async_call("switch", "turn_on", {"entity_id": "switch.daily_planner_matin"}, blocking=True)
    await planner.async_save_schedule("matin", {"time": "08:15"})
    freezer.move_to(dt_util.as_utc(datetime(2026, 11, 18, 8, 15, 0, tzinfo=dt_util.get_time_zone("Europe/Paris"))))
    async_fire_time_changed(hass)
    await hass.async_block_till_done()
    assert len(calls) == 2


async def test_ws_run_list_delete(hass: HomeAssistant, hass_ws_client) -> None:
    """Run now, list and delete through the websocket API."""
    calls = async_mock_service(hass, "light", "turn_off")
    await _setup(hass)
    client = await hass_ws_client(hass)
    await client.send_json_auto_id(
        {
            "type": "daily_planner/save",
            "schedule_id": "nuit",
            "name": "Nuit",
            "time": "23:00",
            "days": [0, 1, 2, 3, 4, 5, 6],
            "actions": [{"action": "light.turn_off", "target": {"entity_id": "light.salon"}}, {"delay": 0}],
        }
    )
    assert (await client.receive_json())["success"]

    await client.send_json_auto_id({"type": "daily_planner/run", "schedule_id": "nuit"})
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    assert len(calls) == 1
    assert hass.states.get("switch.daily_planner_nuit").attributes["last_run"] is not None

    await client.send_json_auto_id({"type": "daily_planner/list"})
    assert [s["id"] for s in (await client.receive_json())["result"]] == ["nuit"]

    await client.send_json_auto_id({"type": "daily_planner/delete", "schedule_id": "nuit"})
    assert (await client.receive_json())["success"]
    await hass.async_block_till_done()
    assert hass.states.get("switch.daily_planner_nuit") is None

    await client.send_json_auto_id({"type": "daily_planner/run", "schedule_id": "nuit"})
    assert not (await client.receive_json())["success"]


async def test_invalid_input_rejected(hass: HomeAssistant, hass_ws_client) -> None:
    """Bad time, bad id and bad actions are refused."""
    await _setup(hass)
    client = await hass_ws_client(hass)
    for payload in (
        {"schedule_id": "x", "time": "25:00"},
        {"schedule_id": "Bad Id"},
        {"schedule_id": "x", "actions": [{"nonsense": True}]},
    ):
        await client.send_json_auto_id({"type": "daily_planner/save", **payload})
        msg = await client.receive_json()
        assert not msg["success"], payload


async def test_persisted_across_restart(hass: HomeAssistant, hass_ws_client, hass_storage) -> None:
    """Schedules are restored from storage."""
    hass_storage["daily_planner.schedules"] = {
        "version": 1,
        "key": "daily_planner.schedules",
        "data": {
            "schedules": {
                "soir": {"name": "Soir", "enabled": False, "time": "21:30", "days": [5, 6], "actions": []}
            }
        },
    }
    await _setup(hass)
    state = hass.states.get("switch.daily_planner_soir")
    assert state.state == "off"
    assert state.attributes["time"] == "21:30"
