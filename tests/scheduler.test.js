const { normalizeSchedule, CRON_NICKNAMES } = require('../src/scheduler');

describe('scheduler', () => {
  describe('normalizeSchedule', () => {
    it('accepts a five-field expression and reports upcoming runs', () => {
      const result = normalizeSchedule('0 5 * * *');

      expect(result.pattern).toBe('0 5 * * *');
      expect(result.upcoming).toHaveLength(3);
      expect(result.upcoming[0] instanceof Date).toBe(true);
      // Run times must be strictly increasing, otherwise the operator is being
      // shown the same time three times and learns nothing from the startup log.
      expect(result.upcoming[1].getTime()).toBeGreaterThan(result.upcoming[0].getTime());
    });

    it('collapses redundant whitespace', () => {
      expect(normalizeSchedule('  0   5  *  * *  ').pattern).toBe('0 5 * * *');
    });

    it('accepts nicknames, which the old shell validation rejected', () => {
      for (const nickname of CRON_NICKNAMES) {
        expect(normalizeSchedule(nickname).pattern).toBe(nickname);
      }
    });

    it('rejects six- and seven-field expressions', () => {
      // The old regex accepted these because it only checked which characters
      // appeared. "0 5 * * * *" is not "05:00 daily" — croner reads the leading
      // field as seconds, making it hourly.
      expect(() => normalizeSchedule('0 5 * * * *')).toThrow(/exactly five fields/);
      expect(() => normalizeSchedule('* * * * * * *')).toThrow(/exactly five fields/);
    });

    it('rejects too few fields', () => {
      expect(() => normalizeSchedule('0 5 * *')).toThrow(/exactly five fields/);
    });

    it('rejects shell metacharacters', () => {
      expect(() => normalizeSchedule('0 5 * * * ; rm -rf /')).toThrow(/exactly five fields/);
      expect(() => normalizeSchedule('0 5 * * *; id')).toThrow();
      expect(() => normalizeSchedule('0 5 * * * && id')).toThrow();
      expect(() => normalizeSchedule('0 5 * * * $(id)')).toThrow();
    });

    it('rejects out-of-range field values', () => {
      expect(() => normalizeSchedule('99 5 * * *')).toThrow(/minute/i);
      expect(() => normalizeSchedule('0 25 * * *')).toThrow(/hour/i);
    });

    it('rejects a pattern that can never fire', () => {
      // 31 February parses cleanly but produces no run times, so the container
      // would have looked healthy and synced nothing, ever.
      expect(() => normalizeSchedule('0 5 31 2 *')).toThrow(/never fire/);
    });

    it('rejects an unsupported nickname', () => {
      expect(() => normalizeSchedule('@reboot')).toThrow(/Unsupported CRON_TASK nickname/);
      expect(() => normalizeSchedule('@fortnightly')).toThrow(/Unsupported CRON_TASK nickname/);
    });

    it('rejects missing or non-string values', () => {
      expect(() => normalizeSchedule(undefined)).toThrow(/CRON_TASK is not set/);
      expect(() => normalizeSchedule('')).toThrow(/CRON_TASK is not set/);
      expect(() => normalizeSchedule('   ')).toThrow(/CRON_TASK is not set/);
      expect(() => normalizeSchedule(null)).toThrow(/CRON_TASK is not set/);
      expect(() => normalizeSchedule(5)).toThrow(/CRON_TASK is not set/);
    });

    it('accepts named and ranged day-of-week values', () => {
      expect(normalizeSchedule('0 5 * * MON').pattern).toBe('0 5 * * MON');
      expect(normalizeSchedule('30 6 * * 1-5').pattern).toBe('30 6 * * 1-5');
      expect(normalizeSchedule('*/15 * * * *').pattern).toBe('*/15 * * * *');
    });
  });
});
