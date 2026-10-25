'use strict';

const Homey = require('homey');
const { validateHost } = require('../../lib/model');

class LennoxDriver extends Homey.Driver {
  async onInit() {
    const actions = {
      heat_target_set: ['heat', 'temperature'],
      cool_target_set: ['cool', 'temperature'],
      fan_mode_set: ['fan', 'mode'],
    };
    for (const [id, [type, argument]] of Object.entries(actions)) {
      this.homey.flow.getActionCard(id).registerRunListener(async (args) => {
        await args.device.writeCommand({ type, value: args[argument] });
        return true;
      });
    }
    this.homey.flow.getConditionCard('hvac_state_is').registerRunListener(async ({ device, state }) => {
      if (!device.getAvailable()) throw new Error('Thermostat is unavailable.');
      return device.getCapabilityValue('hvac_state') === state;
    });
  }

  async onPair(session) {
    let candidates = [];
    let revision = 0;
    let disconnected = false;
    session.setHandler('connect', async ({ host } = {}) => {
      if (disconnected) throw new Error('Pairing closed. Start adding the thermostat again.');
      const current = ++revision;
      // Never retain a prior host's results if a new connection attempt fails.
      candidates = [];
      const address = validateHost(host);
      const found = await this.homey.app.sessions.inspect(address);
      if (disconnected || current !== revision) throw new Error('This connection attempt was superseded. Try again.');
      candidates = found;
      if (!candidates.length) throw new Error('No supported thermostat zones were found at this address.');
      return { count: candidates.length };
    });
    session.setHandler('list_devices', async () => candidates);
    session.setHandler('disconnect', async () => { disconnected = true; revision += 1; candidates = []; });
  }

  async onRepair(session, device) {
    session.setHandler('repair_info', async () => ({ host: device.getSetting('host') || '' }));
    session.setHandler('connect', async ({ host } = {}) => {
      const address = validateHost(host);
      await device.reconnectHost(address);
      return { repaired: true };
    });
  }
}

module.exports = LennoxDriver;
