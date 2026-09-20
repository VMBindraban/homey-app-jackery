Adds support for the Jackery SolarVault home battery system.

The app talks to your SolarVault over your own MQTT broker on the local network, so no cloud account is needed.

Features:
- Battery state of charge, temperature and charge/discharge power
- Grid import/export and home consumption (via the Jackery smart meter)
- Solar (PV) power
- Cumulative charged and discharged energy for the Homey Energy tab
- Charge limit, discharge limit and maximum output power
- Work mode (Self-consumption, Custom, Tariff, AI)
- Follow meter (Custom mode), default output power readout
- EPS (backup output) switch

Flow cards:
- Set charge limit
- Set discharge limit
- Set maximum output power
- Set work mode
- Set follow meter
- Reboot SolarVault

Setup:
1. Point your SolarVault at an MQTT broker on your network.
2. Open the app settings in Homey and enter the broker host, port, credentials, the Jackery device token and the topic prefix.
3. Add a SolarVault device and enter its serial number (shown in the Jackery app under device info, and on the label of the unit).

Note: the SolarVault has no local "charge now" or "discharge now" command. To charge from the grid or discharge at a chosen moment, configure time slots in the Custom mode schedule in the Jackery app and switch the work mode to Custom from a flow.

This app is not affiliated with or endorsed by Jackery.
