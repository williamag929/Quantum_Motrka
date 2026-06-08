'use strict';

/**
 * Trust store for email contacts.
 *
 * Trust levels:
 *   5 — Closest (spouse, parent)     → auto-send if confidence ≥ 6
 *   4 — Close family / best friends  → auto-send if confidence ≥ 8
 *   3 — Extended family / colleagues → approval email required
 *   2 — Acquaintances / work         → desktop notification only
 *   1 — Known but low trust          → silent queue
 *   0 — Unknown (not in list)        → silent queue
 *
 * Storage: ~/.motkra/email-contacts.json
 * Format:  [{ "email": "mom@gmail.com", "name": "Mom", "trust": 5 }]
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CONTACTS_FILE = path.join(os.homedir(), '.motkra', 'email-contacts.json');

function load() {
  try { return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8')); }
  catch { return []; }
}

function save(contacts) {
  const dir = path.dirname(CONTACTS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
}

/** Extract bare email address from "Name <addr>" or plain "addr". */
function bareAddr(raw) {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

/** Return trust level 0–5 for an email address (0 = unknown). */
function getTrust(emailAddress) {
  const addr     = bareAddr(emailAddress);
  const contacts = load();
  return contacts.find(c => bareAddr(c.email) === addr)?.trust ?? 0;
}

/** Add or update a contact. */
function addContact(email, name, trust) {
  const contacts = load();
  const addr     = bareAddr(email);
  const existing = contacts.find(c => bareAddr(c.email) === addr);
  if (existing) { existing.name = name; existing.trust = trust; }
  else contacts.push({ email, name, trust });
  save(contacts);
}

/** Remove a contact by email address. */
function removeContact(email) {
  const addr     = bareAddr(email);
  const contacts = load().filter(c => bareAddr(c.email) !== addr);
  save(contacts);
}

function listContacts() { return load(); }

module.exports = { getTrust, addContact, removeContact, listContacts };
