'use strict';
// Reading a bank's CSV export (server/csv.js): the delimiter, quotes, the columns by their header, dates and amounts in
// the shapes banks send, debit/credit pairs, and rows that cannot be read said, never guessed.
const assert = require('assert');
const { readCsv, readDate, readAmount } = require('../server/csv');

assert.strictEqual(readDate('2026-11-18'), '2026-11-18');
assert.strictEqual(readDate('11/18/2026'), '2026-11-18');
assert.strictEqual(readDate('18/11/2026'), '2026-11-18', 'a first number over 12 is a day');
assert.strictEqual(readDate('01/02/2026', true), '2026-02-01', 'a day-first file');
assert.strictEqual(readDate('18.11.2026'), '2026-11-18');
assert.strictEqual(readDate('Nov 18, 2026'), '2026-11-18');
assert.strictEqual(readDate('18 Nov 2026'), '2026-11-18');
assert.strictEqual(readDate('2026-02-30'), null, 'no 30th of February');
assert.strictEqual(readDate('soon'), null);

assert.strictEqual(readAmount('-12.34'), -1234);
assert.strictEqual(readAmount('(12.34)'), -1234);
assert.strictEqual(readAmount('$1,234.56'), 123456);
assert.strictEqual(readAmount('1.234,56'), 123456, 'comma decimals');
assert.strictEqual(readAmount('12,5'), 1250);
assert.strictEqual(readAmount('12.34 DR'), -1234);
assert.strictEqual(readAmount('12.34 CR'), 1234);
assert.strictEqual(readAmount('7'), 700);
assert.strictEqual(readAmount(''), null);
assert.strictEqual(readAmount('n/a'), null);

// A typical export: quoted payees with commas, a signed amount.
let r = readCsv('Date,Description,Amount,Category\n2026-11-02,"Corner Grocer, Main St",-23.18,Groceries\n2026-11-01,Paycheck,2500.00,\n');
assert.strictEqual(r.problem, null);
assert.deepStrictEqual(r.rows, [
    { posted_on: '2026-11-02', amount_cents: -2318, payee: 'Corner Grocer, Main St', memo: '', category: 'Groceries' },
    { posted_on: '2026-11-01', amount_cents: 250000, payee: 'Paycheck', memo: '', category: '' },
]);

// Debit and credit columns, semicolons, a day-first file, a byte order mark, a row that cannot be read.
r = readCsv('﻿Booking Date;Payee;Memo;Debit;Credit\r\n15/10/2026;Rent;October;1200,00;\r\n03/11/2026;Refund;;;"19,99"\r\nlater;Mystery;;5,00;\r\n');
assert.deepStrictEqual(r.rows.map((x) => [x.posted_on, x.amount_cents, x.payee, x.memo]), [
    ['2026-10-15', -120000, 'Rent', 'October'],
    ['2026-11-03', 1999, 'Refund', ''],
]);
assert.deepStrictEqual(r.skipped.map((s) => s.line), [4]);
assert.match(r.skipped[0].why, /date/);

// Tabs, and a description beside a payee is the memo.
r = readCsv('Posted Date\tPayee\tDescription\tAmount\n2026-11-05\tSTREAMCO\tMonthly plan\t-9.99\n');
assert.deepStrictEqual(r.rows[0], { posted_on: '2026-11-05', amount_cents: -999, payee: 'STREAMCO', memo: 'Monthly plan', category: '' });

// What a file is missing is said.
assert.match(readCsv('Description,Amount\nx,1\n').problem, /No date column/);
assert.match(readCsv('Date,Description\n2026-11-01,x\n').problem, /No amount column/);
assert.match(readCsv('Date,Amount\n').problem, /no rows/);

console.log('csv: dates, amounts, columns, delimiters and unreadable rows');
