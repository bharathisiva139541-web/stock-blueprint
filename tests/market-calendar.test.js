// Tests for api/_lib/market-calendar.js (NSE session / holiday helpers).
(function () {
  'use strict';

  const test = require('node:test');
  const assert = require('node:assert/strict');
  const path = require('node:path');
  const childProcess = require('node:child_process');
  const cal = require('../api/_lib/market-calendar');

  // An IST wall-clock time built from UTC parts (IST = UTC + 05:30), so the
  // test never depends on the machine's own time zone.
  const ist = function (y, mo, d, hh, mm, ss) {
    return new Date(Date.UTC(y, mo - 1, d, hh || 0, mm || 0, ss || 0) - 330 * 60000);
  };

  test('weekends are not trading days', function () {
    assert.equal(cal.isTradingDay('2026-10-17'), false); // Saturday
    assert.equal(cal.isTradingDay('2026-10-18'), false); // Sunday
    assert.equal(cal.sessionState(ist(2026, 10, 17, 11, 0)), 'weekend');
    assert.equal(cal.sessionState(ist(2026, 10, 18, 11, 0)), 'weekend');
    assert.equal(cal.isTradingDay('2026-10-14'), true); // ordinary Wednesday
  });

  test('known NSE holidays (2025 and 2026)', function () {
    assert.equal(cal.isTradingDay('2026-01-26'), false); // Republic Day (Monday)
    assert.equal(cal.holidayName('2026-01-26'), 'Republic Day');
    assert.equal(cal.isTradingDay('2026-10-20'), false); // Dussehra (Tuesday)
    assert.equal(cal.isTradingDay('2026-01-15'), false); // Maharashtra municipal elections
    assert.equal(cal.isTradingDay('2025-12-25'), false); // Christmas 2025
    assert.equal(cal.sessionState(ist(2026, 1, 26, 10, 0)), 'holiday');
    assert.equal(cal.holidayName('2026-10-14'), null);
    assert.equal(cal.isTradingDay(ist(2026, 1, 26, 23, 59)), false); // Date input, late evening IST
  });

  test('holiday list is well formed and covers 2025 and 2026', function () {
    const keys = Object.keys(cal.NSE_HOLIDAYS);
    assert.ok(keys.length >= 28);
    keys.forEach(function (d) {
      assert.match(d, /^\d{4}-\d{2}-\d{2}$/);
      assert.notEqual(cal.parseIstDateTime(d), null, d + ' is a real date');
      const wd = cal.weekdayOf(d);
      assert.ok(wd >= 1 && wd <= 5, d + ' falls on a weekday');
    });
    assert.deepEqual(cal.COVERED_YEARS, [2025, 2026]);
    assert.equal(cal.isCalendarCovered('2026-06-01'), true);
    assert.equal(cal.isCalendarCovered('2027-06-01'), false);
    assert.equal(cal.isTradingDay('2027-01-26'), true); // not covered: only weekends are known
  });

  test('session boundaries 09:00 / 09:14 / 09:15 / 15:30 / 15:31 IST', function () {
    assert.equal(cal.sessionState(ist(2026, 10, 14, 8, 59)), 'closed');
    assert.equal(cal.sessionState(ist(2026, 10, 14, 9, 0)), 'pre-open');
    assert.equal(cal.sessionState(ist(2026, 10, 14, 9, 14)), 'pre-open');
    assert.equal(cal.sessionState(ist(2026, 10, 14, 9, 14, 59)), 'pre-open');
    assert.equal(cal.sessionState(ist(2026, 10, 14, 9, 15)), 'open');
    assert.equal(cal.sessionState(ist(2026, 10, 14, 12, 0)), 'open');
    assert.equal(cal.sessionState(ist(2026, 10, 14, 15, 30)), 'open');
    assert.equal(cal.sessionState(ist(2026, 10, 14, 15, 30, 1)), 'closed');
    assert.equal(cal.sessionState(ist(2026, 10, 14, 15, 31)), 'closed');
    assert.equal(cal.sessionState(ist(2026, 10, 14, 23, 59)), 'closed');
    assert.equal(cal.isSessionOpen(ist(2026, 10, 14, 9, 15)), true);
    // epoch ms and IST strings work too
    assert.equal(cal.sessionState(ist(2026, 10, 14, 9, 15).getTime()), 'open');
    assert.equal(cal.sessionState('2026-10-14 09:14'), 'pre-open');
  });

  test('lastCompletedSession', function () {
    // Monday morning -> previous Friday
    assert.equal(cal.lastCompletedSession(ist(2026, 10, 19, 10, 0)), '2026-10-16');
    // Monday after the close -> Monday
    assert.equal(cal.lastCompletedSession(ist(2026, 10, 19, 15, 31)), '2026-10-19');
    // at 15:30 exactly the session is still open -> previous day
    assert.equal(cal.lastCompletedSession(ist(2026, 10, 19, 15, 30)), '2026-10-16');
    // Saturday -> Friday
    assert.equal(cal.lastCompletedSession(ist(2026, 10, 17, 12, 0)), '2026-10-16');
    // Dussehra (Tue 2026-10-20) -> Monday
    assert.equal(cal.lastCompletedSession(ist(2026, 10, 20, 16, 0)), '2026-10-19');
    // Tuesday after the Republic Day Monday holiday, before the open -> previous Friday
    assert.equal(cal.lastCompletedSession(ist(2026, 1, 27, 9, 0)), '2026-01-23');
    assert.equal(cal.nextTradingDay('2026-10-16'), '2026-10-19');
    assert.equal(cal.nextTradingDay('2026-10-19'), '2026-10-21'); // skips Dussehra
  });

  test('IST date strings around UTC midnight', function () {
    assert.equal(cal.istDateStr(new Date(Date.UTC(2026, 9, 13, 18, 29))), '2026-10-13');
    assert.equal(cal.istDateStr(new Date(Date.UTC(2026, 9, 13, 18, 30))), '2026-10-14');
    assert.equal(cal.istDateTimeStr(new Date(Date.UTC(2026, 9, 14, 3, 45))), '2026-10-14 09:15');
    assert.equal(cal.parseIstDateTime('2026-10-14 09:15'), Date.UTC(2026, 9, 14, 3, 45));
    assert.equal(cal.addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(cal.addDays('2024-03-01', -1), '2024-02-29');
  });

  test('bad input never throws', function () {
    assert.equal(cal.sessionState('not a date'), null);
    assert.equal(cal.sessionState(new Date(NaN)), null);
    assert.equal(cal.isTradingDay(undefined), false);
    assert.equal(cal.lastCompletedSession(null), null);
    assert.equal(cal.parseIstDateTime('2026-02-30'), null);
    assert.equal(cal.istDateStr('2026-13-01'), null);
    assert.equal(cal.holidayName({}), null);
  });

  test('results do not depend on the process time zone (TZ)', function () {
    const modPath = path.join(__dirname, '..', 'api', '_lib', 'market-calendar.js');
    const script =
      'const cal = require(' + JSON.stringify(modPath) + ');' +
      'const at = (s) => Date.UTC(2026, 9, 14, 0, 0, 0) + s * 1000 - 330 * 60000;' +
      'const out = [9*3600+14*60, 9*3600+15*60, 15*3600+30*60, 15*3600+31*60].map((s) => cal.sessionState(at(s)));' +
      'out.push(cal.lastCompletedSession(at(10*3600)), cal.istDateStr(new Date(Date.UTC(2026, 9, 13, 18, 30))),' +
      // 20:00 UTC is already the next day in IST: Dussehra (holiday) and a Saturday
      '  cal.isTradingDay(new Date(Date.UTC(2026, 9, 19, 20, 0))), cal.isTradingDay(new Date(Date.UTC(2026, 9, 16, 20, 0))));' +
      'process.stdout.write(JSON.stringify(out));';
    const expected = JSON.stringify(['pre-open', 'open', 'open', 'closed', '2026-10-13', '2026-10-14', false, false]);
    ['UTC', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati', 'Asia/Tokyo'].forEach(function (tz) {
      const env = Object.assign({}, process.env, { TZ: tz });
      const outText = childProcess.execFileSync(process.execPath, ['-e', script], { env: env, encoding: 'utf8' });
      assert.equal(outText, expected, 'TZ=' + tz);
    });
  });
})();
