// fengari (a Lua 5.3 VM in JavaScript, test-only) ships no types; only what parity.test.ts uses.
declare module 'fengari' {
  const fengari: {
    lua: { lua_pcall(L: unknown, nargs: number, nresults: number, errfunc: number): number; lua_tojsstring(L: unknown, i: number): string }
    lauxlib: { luaL_newstate(): unknown; luaL_loadbuffer(L: unknown, buf: Uint8Array, sz: null, name: Uint8Array): number }
    lualib: { luaL_openlibs(L: unknown): void }
    to_luastring(s: string): Uint8Array
  }
  export default fengari
}
