// The optional game targets activate split routing; defaults retain the combined API.
export function apiDestination(
  incoming,
  { accounts, hearts = accounts, euchre = accounts, legacy = accounts }
) {
  let target = accounts,
    path;
  const value = incoming.pathname;
  if (value.startsWith('/api/hearts/')) {
    target = hearts;
    path = value.slice('/api/hearts'.length);
  } else if (value.startsWith('/api/euchre/')) {
    target = euchre;
    path = '/account/euchre' + value.slice('/api/euchre'.length);
  } else if (value.startsWith('/api/account/euchre/')) {
    target = euchre;
    path = value.slice(4);
  } else if (/^\/api\/(?:games|lobbies|stats|preferences|leaderboard)(?:\/|$)/.test(value)) {
    target = hearts;
    path = value.slice(4);
  } else if (value.startsWith('/api/')) path = value.slice(4);
  else if (/^\/hearts\/socket\.io\/?$/.test(value)) {
    target = hearts;
    path = '/socket.io/';
  } else if (/^\/euchre\/socket\.io\/?$/.test(value)) {
    target = euchre;
    path = '/socket.io/';
  } else if (/^\/socket\.io\/?$/.test(value)) {
    target = legacy;
    path = '/socket.io/';
  } else return null;
  if (!target) return { retired: true };
  const destination = new URL(target);
  destination.pathname = destination.pathname.replace(/\/$/, '') + path;
  destination.search = incoming.search;
  return destination;
}
