// Clans: create, invite, join, roles, leave/kick, the shared vault (at the
// banner) and clan chat. All membership changes are stored right away.

import { canDo, clanNameProblem, clanTagProblem, ROLES, describeRaidWindow } from '../src/net/rules.js';
import { MP_RESOURCE_KEYS } from '../src/net/mpsave.js';
import * as players from './players.js';
import * as building from './building.js';

export function clanPayload(gs, clan) {
  const banner = building.bannerOf(gs, clan.id);
  const raid = gs.raidState(clan.id);
  let structures = 0;
  for (const st of gs.structures.values()) if (st.clanId === clan.id) structures++;
  const per = gs.rules.upkeepPerStructure ?? {};
  const upkeep = Object.fromEntries(Object.entries(per).map(([k, v]) => [k, Math.ceil(structures * v)]));
  const invited = [...clan.invites].map((id) => gs.db.account(id)?.name).filter(Boolean);
  return {
    t: 'clan',
    id: clan.id,
    name: clan.name,
    tag: clan.tag,
    members: [...clan.members.values()]
      .map((m) => ({ name: m.name, role: m.role, online: Boolean(gs.byAccount.get(m.accountId)?.conn) }))
      .sort((a, b) => ROLES.indexOf(b.role) - ROLES.indexOf(a.role) || a.name.localeCompare(b.name)),
    invited,
    vault: clan.vault,
    unpaid: clan.unpaid,
    banner: banner ? { x: banner.x, y: banner.y, hp: Math.ceil(banner.hp), maxHp: banner.def.hp } : null,
    raid,
    raidWindow: describeRaidWindow(gs.raidWindows),
    structures,
    upkeepPerWeek: upkeep,
    max: gs.rules.clanMax,
  };
}

export function sendClan(gs, clan) {
  const msg = clanPayload(gs, clan);
  for (const id of clan.members.keys()) {
    const m = gs.byAccount.get(id);
    if (m?.conn) gs.send(m, msg);
  }
}

export function sendInvites(gs, p) {
  const list = [];
  for (const c of gs.clans.values()) if (c.invites.has(p.accountId)) list.push({ id: c.id, name: c.name, tag: c.tag });
  gs.send(p, { t: 'invites', list });
}

function setMembership(gs, accountId, clanId) {
  if (clanId) gs.memberOf.set(accountId, clanId);
  else gs.memberOf.delete(accountId);
  const p = gs.byAccount.get(accountId);
  if (p) {
    p.clanId = clanId ?? null;
    p.infoRev++;
    players.markMe(p);
    if (!clanId) gs.send(p, { t: 'clan', id: null });
  }
}

function memberByName(clan, name) {
  const lower = String(name ?? '').toLowerCase();
  for (const m of clan.members.values()) if (m.name.toLowerCase() === lower) return m;
  return null;
}

/** Handles one clan request; returns a problem text or null. */
export function handle(gs, p, msg) {
  const op = msg.op;
  const clan = p.clanId ? gs.clans.get(p.clanId) : null;
  const me = clan?.members.get(p.accountId);
  switch (op) {
    case 'create': {
      if (clan) return 'Du är redan med i en klan';
      const name = String(msg.name ?? '').trim();
      const tag = String(msg.tag ?? '').trim().toUpperCase();
      const problem = clanNameProblem(name) ?? clanTagProblem(tag);
      if (problem) return problem;
      if (gs.db.clanNameTaken(name, tag)) return 'Namnet eller taggen är upptagen';
      const id = gs.db.createClan({ name, tag, leaderId: p.accountId });
      const c = {
        id, name, tag, createdAt: Date.now(), vault: {}, upkeep: {}, unpaid: false, lastOnlineAt: Date.now(),
        members: new Map([[p.accountId, { accountId: p.accountId, name: p.name, role: 'leader', joinedAt: Date.now() }]]),
        invites: new Set(),
      };
      for (const other of gs.clans.values()) other.invites.delete(p.accountId);
      gs.clans.set(id, c);
      setMembership(gs, p.accountId, id);
      sendClan(gs, c);
      sendInvites(gs, p);
      gs.toast(p, `Klanen [${tag}] ${name} är grundad! Res ett klanbanér ute i vildmarken för att göra anspråk på mark.`, 'level');
      return null;
    }
    case 'invite': {
      if (!clan) return 'Du är inte med i någon klan';
      if (!canDo(me.role, 'invite')) return 'Bara ledare och officerare kan bjuda in';
      if (clan.members.size >= gs.rules.clanMax) return `Klanen är full (max ${gs.rules.clanMax})`;
      const acc = gs.db.accountByName(String(msg.name ?? '').trim());
      if (!acc) return 'Ingen spelare med det namnet';
      if (gs.memberOf.has(acc.id)) return `${acc.name} är redan med i en klan`;
      clan.invites.add(acc.id);
      gs.db.addInvite(clan.id, acc.id);
      const target = gs.byAccount.get(acc.id);
      if (target?.conn) {
        sendInvites(gs, target);
        gs.toast(target, `${p.name} bjuder in dig till [${clan.tag}] ${clan.name}. Öppna Klan för att svara.`, 'component');
      }
      sendClan(gs, clan);
      return null;
    }
    case 'accept': {
      if (clan) return 'Lämna din klan först';
      const c = gs.clans.get(Number(msg.id));
      if (!c || !c.invites.has(p.accountId)) return 'Inbjudan finns inte längre';
      if (c.members.size >= gs.rules.clanMax) return 'Klanen är full';
      gs.db.addMember(c.id, p.accountId, 'member');
      for (const other of gs.clans.values()) other.invites.delete(p.accountId);
      c.members.set(p.accountId, { accountId: p.accountId, name: p.name, role: 'member', joinedAt: Date.now() });
      setMembership(gs, p.accountId, c.id);
      sendClan(gs, c);
      sendInvites(gs, p);
      for (const id of c.members.keys()) {
        const m = gs.byAccount.get(id);
        if (m?.conn && m !== p) gs.toast(m, `${p.name} gick med i klanen!`, 'component');
      }
      return null;
    }
    case 'decline': {
      const c = gs.clans.get(Number(msg.id));
      if (c) {
        c.invites.delete(p.accountId);
        gs.db.removeInvite(c.id, p.accountId);
      }
      sendInvites(gs, p);
      return null;
    }
    case 'leave': {
      if (!clan) return 'Du är inte med i någon klan';
      if (me.role === 'leader' && clan.members.size > 1) return 'Lämna över ledarskapet först (eller upplös klanen)';
      gs.db.removeMember(p.accountId);
      clan.members.delete(p.accountId);
      setMembership(gs, p.accountId, null);
      if (!clan.members.size) disband(gs, clan);
      else sendClan(gs, clan);
      return null;
    }
    case 'kick': {
      if (!clan) return 'Du är inte med i någon klan';
      if (!canDo(me.role, 'kick')) return 'Bara ledare och officerare kan sparka';
      const m = memberByName(clan, msg.name);
      if (!m || m.accountId === p.accountId) return 'Ingen sådan medlem';
      if (ROLES.indexOf(m.role) >= ROLES.indexOf(me.role)) return 'Du kan inte sparka någon med samma eller högre rang';
      gs.db.removeMember(m.accountId);
      clan.members.delete(m.accountId);
      setMembership(gs, m.accountId, null);
      const target = gs.byAccount.get(m.accountId);
      if (target?.conn) gs.toast(target, `Du togs bort ur [${clan.tag}].`, 'warn');
      sendClan(gs, clan);
      return null;
    }
    case 'promote':
    case 'demote':
    case 'transfer': {
      if (!clan) return 'Du är inte med i någon klan';
      if (!canDo(me.role, op)) return 'Bara ledaren kan ändra roller';
      const m = memberByName(clan, msg.name);
      if (!m || m.accountId === p.accountId) return 'Ingen sådan medlem';
      if (op === 'transfer') {
        m.role = 'leader';
        me.role = 'officer';
        gs.db.tx(() => {
          gs.db.setRole(m.accountId, 'leader');
          gs.db.setRole(p.accountId, 'officer');
        });
      } else {
        m.role = op === 'promote' ? 'officer' : 'member';
        gs.db.setRole(m.accountId, m.role);
      }
      for (const id of [m.accountId, p.accountId]) {
        const o = gs.byAccount.get(id);
        if (o) players.markMe(o);
      }
      sendClan(gs, clan);
      return null;
    }
    case 'disband': {
      if (!clan) return 'Du är inte med i någon klan';
      if (!canDo(me.role, 'disband')) return 'Bara ledaren kan upplösa klanen';
      disband(gs, clan);
      return null;
    }
    case 'deposit':
    case 'withdraw': {
      if (!clan) return 'Du är inte med i någon klan';
      if (op === 'withdraw' && !canDo(me.role, 'withdraw')) return 'Bara ledare och officerare kan ta ur valvet';
      if (!building.ownBannerNear(gs, p, 4)) return 'Stå vid klanbanéret för att använda valvet';
      const want = {};
      for (const k of MP_RESOURCE_KEYS) {
        const n = Math.floor(Number(msg.res?.[k] ?? 0));
        if (Number.isFinite(n) && n > 0) want[k] = Math.min(n, 1e7);
      }
      const from = op === 'deposit' ? p.ch.resources : clan.vault;
      const to = op === 'deposit' ? clan.vault : p.ch.resources;
      for (const [k, n] of Object.entries(want)) if ((from[k] ?? 0) < n) return `Inte tillräckligt med ${k}`;
      for (const [k, n] of Object.entries(want)) {
        from[k] -= n;
        to[k] = (to[k] ?? 0) + n;
      }
      try {
        gs.db.tx(() => {
          players.persist(gs, p);
          gs.db.saveClan(clan);
          gs.db.log(p.accountId, `vault-${op}`, null, { clan: clan.id, res: want });
        });
      } catch (err) {
        for (const [k, n] of Object.entries(want)) {
          to[k] -= n;
          from[k] += n;
        }
        gs.log.error('[clan] vault failed', err);
        return 'Valvet kunde inte uppdateras';
      }
      players.markMe(p);
      sendClan(gs, clan);
      return null;
    }
    case 'info':
      if (clan) gs.send(p, clanPayload(gs, clan));
      sendInvites(gs, p);
      return null;
    default:
      return 'Okänt klankommando';
  }
}

function disband(gs, clan) {
  const ids = [...clan.members.keys()];
  gs.db.deleteClan(clan.id);
  gs.clans.delete(clan.id);
  // The base stays standing, unowned, and crumbles over time.
  for (const st of gs.structures.values()) {
    if (st.clanId === clan.id) {
      st.clanId = null;
      gs.broadcastTile(st.x, st.y, { t: 'wd', k: 'st+', st: building.structurePayload(st) });
    }
  }
  for (const id of ids) {
    setMembership(gs, id, null);
    const m = gs.byAccount.get(id);
    if (m?.conn) gs.toast(m, `Klanen [${clan.tag}] är upplöst.`, 'warn');
  }
  gs.broadcast({ t: 'claims', claims: gs.claims() });
}

/** A member logged out: the raid grace period starts when the last one leaves. */
export function memberLeft(gs, accountId) {
  const clan = gs.clanOf(accountId);
  if (!clan) return;
  clan.lastOnlineAt = Date.now();
  clan.dirty = true;
  sendClan(gs, clan);
}

export function memberJoined(gs, accountId) {
  const clan = gs.clanOf(accountId);
  if (clan) sendClan(gs, clan);
}
