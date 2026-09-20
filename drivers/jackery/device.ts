import Homey from 'homey';
import { MqttLite } from '../../lib/mqtt';

interface JackerySettings {
  host?: string;
  port?: number | string;
  username?: string;
  password?: string;
  token?: string;
  prefix?: string;
  serial?: string;
  poll_interval?: number;
  debug?: boolean;
}

interface JackeryMessage {
  type?: number;
  body?: Record<string, any> | null;
  [key: string]: any;
}

const WORK_MODES: Record<number, string> = {
  2: 'self_consumption',
  4: 'custom',
  7: 'tariff',
  8: 'ai',
};

class JackeryDevice extends Homey.Device {
  private state: Record<string, any> = {};
  private lastSeen = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private mqtt: MqttLite | null = null;
  private messageId = 1000;
  private pollCount = 0;
  private onAppSettingChanged: ((key: string) => void) | null = null;

  async onInit(): Promise<void> {
    this.log('Initializing Jackery SolarVault');
    this.state = {};
    this.lastSeen = 0;
    this.pollTimer = null;
    this.mqtt = null;
    this.messageId = 1000;

    await this.setAvailable().catch(() => undefined);
    await this.syncCapabilities();

    // Token used to be a global app setting; copy it to the device once.
    if (!this.getSetting('token') && this.homey.settings.get('token')) {
      await this.setSettings({ token: this.homey.settings.get('token') }).catch(() => undefined);
    }

    this.onAppSettingChanged = (key: string) => {
      if (['host', 'port', 'username', 'password', 'prefix'].includes(key)) {
        void this.connect();
      }
    };

    this.homey.settings.on('set', this.onAppSettingChanged);
    this.homey.settings.on('unset', this.onAppSettingChanged);

    this.registerCapabilityListener('onoff', async (value: boolean) => {
      await this.sendControl({ swEps: value ? 1 : 0 });
    });
    this.registerCapabilityListener('jackery_work_mode', async (value: string) => {
      await this.setWorkMode(value);
    });
    this.registerCapabilityListener('jackery_follow_meter', async (value: boolean) => {
      await this.sendControl({ isFollowMeterPw: value ? 1 : 0 });
    });

    await this.connect();
    this.startPolling();
  }

  // Devices paired with an older version: add new capabilities and refresh ones whose definition changed.
  private async syncCapabilities(): Promise<void> {
    const wanted: string[] = (this.driver as any).manifest.capabilities ?? [];
    for (const capability of wanted) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability).catch((error: Error) => this.error('addCapability', capability, error.message));
      }
    }
    for (const capability of ['jackery_force_charge_now', 'jackery_force_discharge_now', 'jackery_force_charge']) {
      if (this.hasCapability(capability)) await this.removeCapability(capability).catch(() => undefined);
    }
    if (!this.getStoreValue('cap_v3')) {
      for (const capability of ['jackery_work_mode', 'jackery_default_power']) {
        if (this.hasCapability(capability)) await this.removeCapability(capability).catch(() => undefined);
        await this.addCapability(capability).catch((error: Error) => this.error('addCapability', capability, error.message));
      }
      await this.setStoreValue('cap_v3', true);
    }
  }

  private debug(...args: unknown[]): void {
    if ((this.getSettings() as JackerySettings).debug) this.log('[debug]', ...args);
  }

  private getAppSettings(): JackerySettings {
    const get = (key: keyof JackerySettings): unknown => this.homey.settings.get(String(key));

    return {
      host: get('host') as string | undefined,
      port: get('port') as number | string | undefined,
      username: get('username') as string | undefined,
      password: get('password') as string | undefined,
      prefix: get('prefix') as string | undefined,
    };
  }

  private getConnectionSettings(): JackerySettings {
    return { ...this.getAppSettings(), ...(this.getSettings() as JackerySettings) };
  }

  private async setCapability(capability: string, value: unknown): Promise<void> {
    if (!this.hasCapability(capability)) return;
    await this.setCapabilityValue(capability, value).catch((error: Error) => {
      this.error(`setCapabilityValue ${capability}=${String(value)} failed:`, error.message);
    });
  }

  private async connect(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.mqtt?.close();
    this.mqtt = null;

    const settings = this.getConnectionSettings();

    if (!settings.host || !settings.port || !settings.serial || !settings.token) {
      await this.setUnavailable('Configure MQTT settings in the app settings and set the serial number and token in the device settings');
      return;
    }

    this.mqtt = new MqttLite(
      this.log.bind(this),
      {
        host: settings.host,
        port: settings.port,
        username: settings.username,
        password: settings.password,
      },
      (topic, message) => this.handle(topic, message),
    );

    this.log(`Connecting to MQTT ${settings.host}:${settings.port}, serial ${settings.serial}, prefix ${settings.prefix || 'hb'}`);
    this.mqtt.onClose = () => {
      void this.setUnavailable('MQTT disconnected, reconnecting');
      this.reconnectTimer = setTimeout(() => void this.connect(), 10000);
    };

    try {
      await this.mqtt.connect();
      const root = settings.prefix || 'hb';
      const base = `${root}/device/${settings.serial}`;

      this.mqtt.subscribe(`${base}/status`);
      this.mqtt.subscribe(`${base}/event`);
      await this.poll();
      await this.setAvailable();
      this.log('MQTT connected, subscribed to', base);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.setUnavailable(`MQTT connection failed: ${message}`);
    }
  }

  private startPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    const seconds = Number((this.getSettings() as JackerySettings).poll_interval) || 5;
    this.pollTimer = setInterval(() => void this.poll(), seconds * 1000);
  }

  private async poll(): Promise<void> {
    if (!this.mqtt) return;

    const settings = this.getConnectionSettings();
    const root = settings.prefix || 'hb';
    const topic = `${root}/device/${settings.serial}/action`;

    const send = (type: number, body: Record<string, any> | null = null): void => {
      this.debug('poll ->', type, body ?? '');
      this.mqtt?.publish(topic, {
        type,
        eventId: 0,
        messageId: ++this.messageId,
        ts: Math.floor(Date.now() / 1000),
        token: settings.token,
        body,
      });
    };

    // Reply types: 25 -> 2 (live status), 105 -> 106 (system state), 100 -> 101 (sub-devices).
    // Type 23 (cumulative energy) is pushed by the device every ~10 min, not pollable.
    send(25);
    send(2);
    this.pollCount++;
    if (this.pollCount % 3 === 1) {
      send(105);
      send(100, { devType: 2 });
    }
  }

  private handle(_topic: string, message: JackeryMessage): void {
    this.lastSeen = Date.now();
    void this.setAvailable().catch(() => undefined);

    const body = message?.body;
    const data: Record<string, any> = body && typeof body === 'object' ? body : message;
    if (!data || typeof data !== 'object') return;
    this.debug('<- type', message.type, JSON.stringify(data));

    // Merge every message into one state so fields split across types (2/23/101/106) combine.
    for (const [key, value] of Object.entries(data)) {
      if (value != null) this.state[key] = value;
    }
    if (data.workModel != null) this.state.workMode = data.workModel;
    const st = this.state;
    const num = (value: unknown, fallback = 0): number => (value == null || Number.isNaN(Number(value)) ? fallback : Number(value));

    const setNumber = (capability: string, value: unknown): void => {
      if (value != null && !Number.isNaN(Number(value))) {
        void this.setCapability(capability, Number(value)).catch(() => undefined);
      }
    };

    setNumber('measure_battery', st.batSoc);
    setNumber('jackery_chg_limit', st.socChgLimit);
    setNumber('jackery_dis_limit', st.socDischgLimit);
    setNumber('jackery_max_output', st.maxOutPw);
    setNumber('jackery_max_grid', st.maxFeedGrid);
    const workMode = WORK_MODES[num(st.workMode, -1)];
    if (workMode) void this.setCapability('jackery_work_mode', workMode).catch(() => undefined);
    setNumber('jackery_bat_in', st.batInPw);
    setNumber('jackery_bat_out', st.batOutPw);
    setNumber('jackery_pv_power', st.pvPw);
    if (st.cellTemp != null) setNumber('jackery_bat_temp', num(st.cellTemp) * 0.1);
    void this.setCapability('onoff', !!st.swEps).catch(() => undefined);
    if (st.isFollowMeterPw != null) void this.setCapability('jackery_follow_meter', !!Number(st.isFollowMeterPw));
    setNumber('jackery_default_power', st.defaultPw);

    // Grid net (buy - sell): CT collector preferred, then device grid fields.
    const collector = Array.isArray(st.collectors) ? st.collectors[0] : null;
    let gridIn: number | null = null;
    let gridOut: number | null = null;
    if (collector && (collector.inPw != null || collector.outPw != null)) {
      gridIn = num(collector.inPw);
      gridOut = num(collector.outPw);
      setNumber('jackery_smart_power', gridIn - gridOut);
      void this.setCapability('jackery_smart_conn', !!collector.commState).catch(() => undefined);
    } else if (st.gridInPw != null || st.gridOutPw != null) {
      gridIn = num(st.gridInPw);
      gridOut = num(st.gridOutPw);
    } else if (st.inGridSidePw != null || st.outGridSidePw != null) {
      gridIn = num(st.inGridSidePw);
      gridOut = num(st.outGridSidePw);
    }
    setNumber('jackery_grid_in', gridIn);
    setNumber('jackery_grid_out', gridOut);

    // Home load = grid net - on-grid port net (charge - supply), clamped. Same as reference integration.
    const ongridNet = num(st.inOngridPw) - num(st.outOngridPw);
    // Homey Energy home battery convention: positive = charging, negative = discharging.
    setNumber('measure_power', num(st.batInPw) - num(st.batOutPw));
    if (gridIn != null && gridOut != null) {
      const gridNet = gridIn - gridOut;
      setNumber('jackery_home_power', Math.max(0, gridNet - ongridNet));
    } else {
      setNumber('jackery_home_power', Math.max(0, -ongridNet));
    }

    // Cumulative energy (type 23), device unit is 10 Wh -> kWh.
    setNumber('meter_power', st.outOngridEgy != null ? num(st.outOngridEgy) * 0.01 : null);
    setNumber('meter_power.charged', st.batChgEgy != null ? num(st.batChgEgy) * 0.01 : null);
    setNumber('meter_power.discharged', st.batDisChgEgy != null ? num(st.batDisChgEgy) * 0.01 : null);
  }

  async sendRaw(types: number[], body: Record<string, any> | null): Promise<void> {
    const settings = this.getConnectionSettings();
    if (!this.mqtt) throw new Error('Not connected to MQTT');
    const topic = `${settings.prefix || 'hb'}/device/${settings.serial}/action`;
    for (const type of types) {
      this.log('raw ->', type, JSON.stringify(body));
      this.mqtt.publish(topic, {
        type,
        eventId: 0,
        messageId: ++this.messageId,
        ts: Math.floor(Date.now() / 1000),
        token: settings.token,
        body,
      });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  async setWorkMode(mode: string): Promise<void> {
    const code = Number(Object.keys(WORK_MODES).find(key => WORK_MODES[Number(key)] === mode));
    if (!code) throw new Error(`Unknown work mode ${mode}`);
    this.log('Work mode ->', mode, code);
    await this.sendControl({ workModel: code });
  }

  async sendControl(params: Record<string, number>): Promise<void> {
    const settings = this.getConnectionSettings();
    if (!this.mqtt) throw new Error('Not connected to MQTT');

    const root = settings.prefix || 'hb';
    const topic = `${root}/device/${settings.serial}/action`;
    this.log('control ->', JSON.stringify(params));

    this.mqtt.publish(topic, {
      type: 1,
      eventId: 3,
      messageId: ++this.messageId,
      ts: Math.floor(Date.now() / 1000),
      token: settings.token,
      body: { cmd: 5, rc: 1, ...params },
    });
  }

  async onSettings({ changedKeys }: { changedKeys: string[] }): Promise<void> {
    if (changedKeys.includes('poll_interval')) this.startPolling();
    if (changedKeys.includes('serial') || changedKeys.includes('token')) await this.connect();
  }

  async onDeleted(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    if (this.onAppSettingChanged) {
      this.homey.settings.off('set', this.onAppSettingChanged);
      this.homey.settings.off('unset', this.onAppSettingChanged);
    }

    this.mqtt?.close();
    this.mqtt = null;
  }
}

module.exports = JackeryDevice;
