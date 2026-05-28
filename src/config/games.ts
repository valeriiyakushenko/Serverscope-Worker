// Full config structure example:
//
// {
//   appid: 107410,
//   name: 'Arma 3',
//   baseFilter: '\\dedicated\\1',        // mandatory filter, always appended for this game
//   fallbackFilters: [                    // used when response hits the 10k API limit
//     {
//       label: 'Region EU',
//       extraFilter: '\\region\\3',
//       children: [
//         {
//           label: 'Region EU — with players',
//           extraFilter: '\\hasplayers\\1',
//         },
//         {
//           label: 'Region EU — empty',
//           extraFilter: '\\noplayers\\1',
//         },
//       ],
//     },
//     {
//       label: 'Region US',
//       extraFilter: '\\region\\1',
//     },
//   ],
// }

export interface FilterNode {
  label: string
  extraFilter: string
  children?: FilterNode[]
}

export interface GameConfig {
  appid: number
  name: string
  baseFilter?: string
  fallbackFilters?: FilterNode[]
}

export const TRACKED_GAMES: GameConfig[] = [
  { appid: 221100, name: 'DayZ' },
  { appid: 252490, name: 'Rust' },
  { appid: 107410, name: 'Arma 3' },
  { appid: 304930, name: 'Unturned' },
  { appid: 892970, name: 'Valheim' },
  { appid: 1203620, name: 'Enshrouded' },
  { appid: 251570, name: '7 Days to Die' },
  { appid: 686810, name: 'Hell Let Loose' },
  { appid: 2646460, name: 'Soulmask' },
  { appid: 1604030, name: 'V Rising' },
  { appid: 346110, name: 'ARK: Survival Evolved' },
  { appid: 4000, name: 'Garry\'s Mod' },
  { appid: 240, name: 'Counter-Strike: Source' },
  { appid: 440, name: 'Team Fortress 2' },
  { appid: 730, name: 'Counter-Strike 2', baseFilter: '\\nor\\1\\gametype\\hidden'},
]
