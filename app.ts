import Homey from 'homey';

class JackeryApp extends Homey.App {
  async onInit(): Promise<void> {
    const flow = this.homey.flow;

    flow.getActionCard('set_charge_limit').registerRunListener(async (args: any) => {
      await args.device.sendControl({ socChgLimit: Number(args.limit) });
    });

    flow.getActionCard('set_discharge_limit').registerRunListener(async (args: any) => {
      await args.device.sendControl({ socDischgLimit: Number(args.limit) });
    });

    flow.getActionCard('set_max_output').registerRunListener(async (args: any) => {
      await args.device.sendControl({ maxOutPw: Number(args.power) });
    });

    flow.getActionCard('set_work_mode').registerRunListener(async (args: any) => {
      await args.device.setWorkMode(args.mode);
    });

    flow.getActionCard('set_follow_meter').registerRunListener(async (args: any) => {
      await args.device.sendControl({ isFollowMeterPw: args.state === 'on' ? 1 : 0 });
    });

    flow.getActionCard('send_raw_message').registerRunListener(async (args: any) => {
      const types = String(args.types).split(',').map((t: string) => Number(t.trim())).filter((n: number) => Number.isInteger(n));
      if (!types.length) throw new Error('No valid types');
      let body: Record<string, any> | null = null;
      if (args.body && args.body.trim()) {
        try {
          body = JSON.parse(args.body);
        } catch {
          throw new Error('Invalid JSON body');
        }
      }
      await args.device.sendRaw(types, body);
    });

    flow.getActionCard('reboot').registerRunListener(async (args: any) => {
      await args.device.sendControl({ reboot: 1 });
    });

    this.homey.dashboards.getWidget('solarvault')
      .registerSettingAutocompleteListener('device', async (query: string) => {
        return this.homey.drivers.getDriver('jackery').getDevices()
          .map(device => ({ name: device.getName(), id: device.getData().id }))
          .filter(item => item.name.toLowerCase().includes(query.toLowerCase()));
      });

    this.log('Jackery SolarVault app ready');
  }
}

module.exports = JackeryApp;
