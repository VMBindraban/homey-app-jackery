'use strict';

module.exports = {
  async getState({ homey, query }) {
    const device = homey.drivers.getDriver('jackery').getDevices()
      .find(d => d.getData().id === query.device);
    if (!device) throw new Error('SolarVault not found. Select it in the widget settings.');

    const get = cap => device.getCapabilityValue(cap);
    return {
      name: device.getName(),
      available: device.getAvailable(),
      soc: get('measure_battery'),
      battery: get('measure_power'),
      pv: get('jackery_pv_power'),
      gridIn: get('jackery_grid_in'),
      gridOut: get('jackery_grid_out'),
      home: get('jackery_home_power'),
      mode: get('jackery_work_mode'),
    };
  },
};
