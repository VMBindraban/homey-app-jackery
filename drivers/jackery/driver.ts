import Homey from 'homey';

class JackeryDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    this.log('Jackery SolarVault driver ready');
  }

  async onPair(session: any): Promise<void> {
    let serial = '';
    let token = '';

    session.setHandler('device', async (value: { serial?: unknown; token?: unknown }) => {
      serial = String(value?.serial ?? '').trim();
      token = String(value?.token ?? '').trim();
    });

    session.setHandler('list_devices', async () => {
      if (!serial) return [];
      return [{
        name: 'Jackery SolarVault',
        data: { id: serial },
        settings: { serial, token },
      }];
    });
  }
}

module.exports = JackeryDriver;
