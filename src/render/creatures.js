// Animated creature sprites. Every land creature has hand-made frames for
// walking (and idling / attacking where it matters); the renderer adds
// motion on top (slimes squash and hop, flyers bob, floaters sway).
//
// Maps face right (or set facesLeft). Letters are looked up in the creature's palette, which is
// built from its colour (so elemental variants recolour cleanly).

import { spriteFromMap, flipped, silhouette } from './canvas.js';
import { shadeHex } from '../weapons/visuals.js';

const O = '#161622';

// Palette builders: c is the creature's main colour.
const base = (c) => ({ o: O, m: c, M: shadeHex(c, -0.3), l: shadeHex(c, 0.35), e: '#ffffff', k: O });

const CREATURES = {
  // --- Returning cast, redrawn ---------------------------------------------------------
  slime: {
    pal: (c) => ({ ...base(c), w: shadeHex(c, 0.65), e: O }),
    idle: [
      ['....oooooo....',
       '..oommmmllmo..',
       '.ommmmmmmwlmo.',
       'ommmmmmmmmmmmo',
       'ommmkmmmmkmmmo',
       'ommmkmmmmkmmmo',
       'oMmmmmmmmmmmMo',
       'oMMmmmmmmmmMMo',
       '.oMMMMMMMMMMo.',
       '..oooooooooo..'],
      ['....oooooo....',
       '..oommmmllmo..',
       '.ommmmmmmwlmo.',
       'ommmmmmmmmmmmo',
       'ommmmmmmmmmmmo',
       'ommmoommoommmo',
       'oMmmmmmmmmmmMo',
       'oMMmmmmmmmmMMo',
       '.oMMMMMMMMMMo.',
       '..oooooooooo..'],
    ],
  },
  bat: {
    pal: (c) => ({ ...base(c), e: '#ff4040', t: '#ffffff' }),
    walk: [
      ['o..........o',
       'mo..o..o..om',
       'mmo.omom.omm',
       'Mmmoommmommm',
       '.MmmmememmM.',
       '..oMmmmmmo..',
       '...ootoo....',
       '............'],
      ['............',
       '....o..o....',
       '....omom....',
       '.oooommmooo.',
       'oMmmmememmMo',
       'oMM.omtmo.MM',
       'oo...oo...oo',
       '............'],
      ['............',
       '....o..o....',
       '....omom....',
       '...oommmo...',
       '..omememmo..',
       '.oMmmmtmmMo.',
       'oMmo.oo.omMo',
       'oo........oo'],
    ],
  },
  skeleton: {
    pal: (c) => ({ o: O, w: c, k: shadeHex(c, -0.55), e: '#ff5050', b: '#8a6a3a' }),
    walk: [
      ['...oooo...',
       '..owwwwo..',
       '.owewwewo.',
       '.owwwwwwo.',
       '..owkwko..',
       '...owwo...',
       '..oowwoo..',
       '.owokwowo.',
       '.owowwowo.',
       '..okwwko..',
       '..ow..wo..',
       '..ow..wo..',
       '..oo..oo..'],
      ['...oooo...',
       '..owwwwo..',
       '.owewwewo.',
       '.owwwwwwo.',
       '..owkwko..',
       '...owwo...',
       '..oowwoo..',
       '.owokwowo.',
       '..owwwwo..',
       '..okwwko..',
       '.ow...wo..',
       'ow.....wo.',
       'oo......oo'],
    ],
    attack: [
      ['...oooo..o',
       '..owwwwoob',
       '.owewwewob',
       '.owwwwwwob',
       '..owkwkowo',
       '...owwowo.',
       '..oowwwo..',
       '.owokwo...',
       '.owowwo...',
       '..okwwko..',
       '..ow..wo..',
       '..ow..wo..',
       '..oo..oo..'],
    ],
  },
  brute: {
    pal: (c) => ({ o: O, r: c, R: shadeHex(c, -0.3), t: '#fff4d8', e: '#ffe040', b: '#5a3a22', B: '#8a5a33' }),
    walk: [
      ['....oooooo....',
       '...orrrrrro...',
       '..orrerrerro..',
       '..orrrrrrrro..',
       '..orRttttRro..',
       '.oorrrrrrrroo.',
       'orrorrrrrrorro',
       'orrorrRRrrorro',
       'orrorrrrrrorro',
       '.oo.obbbbo.oo.',
       '....orrrro....',
       '...orro.orro..',
       '...ooo...ooo..'],
      ['....oooooo....',
       '...orrrrrro...',
       '..orrerrerro..',
       '..orrrrrrrro..',
       '..orRttttRro..',
       '.oorrrrrrrroo.',
       'orrorrrrrrorro',
       'orrorrRRrrorro',
       'orrorrrrrrorro',
       '.oo.obbbbo.oo.',
       '....orrrro....',
       '..orro..orro..',
       '..ooo....ooo..'],
    ],
    attack: [
      ['..........oBo.',
       '....oooooooBo.',
       '...orrrrrroBo.',
       '..orrerrerrBo.',
       '..orrrrrrrroo.',
       '..orRttttRro..',
       '.oorrrrrrrrro.',
       'orrorrrrrrrro.',
       'orrorrRRrrro..',
       '.oo.obbbbo....',
       '....orrrro....',
       '...orro.orro..',
       '...ooo...ooo..'],
    ],
  },
  wisp: {
    pal: (c) => ({ o: O, w: c, W: shadeHex(c, -0.25), l: shadeHex(c, 0.55), e: '#ffffff' }),
    walk: [
      ['...o....',
       '..olo...',
       '.olwwo..',
       '.owwwwo.',
       '.oewewo.',
       'owwwwwwo',
       'oWwwwwWo',
       '.oWwwWo.',
       '..oWWo..',
       '...Wo...'],
      ['....o...',
       '...olo..',
       '..owwlo.',
       '.owwwwo.',
       '.oewewo.',
       'owwwwwwo',
       'oWwwwwWo',
       '.oWwwWo.',
       '..oWWo..',
       '...oW...'],
      ['...oo...',
       '..olwo..',
       '.owlwwo.',
       '.owwwwo.',
       '.oewewo.',
       'owwwwwwo',
       'oWwwwwWo',
       '.oWwwWo.',
       '..oWWo..',
       '..W.o...'],
    ],
  },

  // --- New creatures -------------------------------------------------------------------
  // Plains: a tusked boar that charges.
  boar: {
    facesLeft: true,
    pal: (c) => ({ ...base(c), t: '#fff4d8', n: '#e8a0a0', b: shadeHex(c, -0.5) }),
    walk: [
      ['....oo.oo.......',
       '...obbobbooo....',
       '..obmmmmmmmmoo..',
       '.ommmmmmmmmmmmoo',
       'otmmmmmmmmmmmmMo',
       'onnmemmmmmmmmMMo',
       'otmmmmmmmmmmMMo.',
       '.ooMMMMMMMMMMo..',
       '..oMo.oMo.oMo...',
       '..oo..oo..oo....'],
      ['....oo.oo.......',
       '...obbobbooo....',
       '..obmmmmmmmmoo..',
       '.ommmmmmmmmmmmoo',
       'otmmmmmmmmmmmmMo',
       'onnmemmmmmmmmMMo',
       'otmmmmmmmmmmMMo.',
       '.ooMMMMMMMMMMo..',
       '.oMo..oMo..oMo..',
       '.oo...oo....oo..'],
    ],
    attack: [
      ['................',
       '.....oo.oo......',
       '....obbobbooo...',
       '..oobmmmmmmmmoo.',
       'otmmmmmmmmmmmmmo',
       'onnmemmmmmmmmMMo',
       'otmmmmmmmmmMMMo.',
       '.ooMMMMMMMMMMo..',
       'oMo...oMo..oMo..',
       'oo....oo....oo..'],
    ],
  },
  // Forest: a leaping spider with a glowing mark.
  spider: {
    pal: (c) => ({ ...base(c), e: '#ff4040', g: '#7affa0' }),
    walk: [
      ['.o..........o.',
       'omo..oooo..omo',
       '.omoommmmoomo.',
       '..ommmgmmmmo..',
       'oomMmmmmmmmMmo',
       'mmoomememmoomm',
       '.o.oMmmmmMo.o.',
       '.o.o.oooo.o.o.',
       'o..o......o..o'],
      ['..............',
       'o....oooo....o',
       'mo.oommmmoo.om',
       '.moommgmmmmomo',
       '.omMmmmmmmmMo.',
       'omoomememmoomo',
       'mo.oMmmmmMo.om',
       'o.o..oooo..o.o',
       '..o........o..'],
    ],
    attack: [
      ['oo..........oo',
       'mmo.......omm.',
       '.mmo.oooooom..',
       '..ommmgmmmmo..',
       '.omMmmmmmmmMo.',
       '.oomememmmmoo.',
       '.o.oMmmmmMo.o.',
       'o..o.oooo.o..o',
       '..............'],
    ],
  },
  // Desert: a scorpion with a stinging tail.
  scorpion: {
    pal: (c) => ({ ...base(c), s: '#fff4d8', e: O }),
    walk: [
      ['.....oo.........',
       '....omso........',
       '....omo.........',
       '...omo..........',
       '..omo...oooooo..',
       '.omo..oommmmmmoo',
       '.omooommememmmmo',
       '..oMmmmmmmmmmmoo',
       '..o.oMMMMMMMMo.o',
       '.o.o.o.o.o.o.omo',
       '.......o.o..oo..'],
      ['.....oo.........',
       '....omso........',
       '....omo.........',
       '...omo..........',
       '..omo...oooooo..',
       '.omo..oommmmmmoo',
       '.omooommememmmmo',
       '..oMmmmmmmmmmmoo',
       '..o.oMMMMMMMMo.o',
       '..o.o.o.o.o.o.mo',
       '.o.o.o.o....oo..'],
    ],
    attack: [
      ['..........oo....',
       '.......oooso....',
       '.....oommmo.....',
       '....omo.........',
       '...omo..oooooo..',
       '..omo.oommmmmmoo',
       '..omoommememmmmo',
       '...oMmmmmmmmmmoo',
       '..o.oMMMMMMMMo.o',
       '.o.o.o.o.o.o.omo',
       '.......o.o..oo..'],
    ],
  },
  // Desert: a shambling mummy.
  mummy: {
    pal: (c) => ({ ...base(c), e: '#7affd0', b: shadeHex(c, -0.45) }),
    walk: [
      ['...oooo.....',
       '..ommmmo....',
       '..omeemo....',
       '..obmmbo....',
       '.oommmmooo..',
       'ommbmmmmbmo.',
       'oo.ommmmoooo',
       '...ombmmo...',
       '...ommbmo...',
       '...om.mo....',
       '...om.mo....',
       '...oo.oo....'],
      ['...oooo.....',
       '..ommmmo....',
       '..omeemo....',
       '..obmmbo....',
       '.oommmmooo..',
       'ommbmmmmbmo.',
       'oo.ommmmoooo',
       '...ombmmo...',
       '...ommbmo...',
       '..om..mo....',
       '.om...om....',
       '.oo...oo....'],
    ],
  },
  // Snow: a fast wolf that hunts in packs.
  wolf: {
    facesLeft: true,
    pal: (c) => ({ ...base(c), e: '#7ad8ff', n: O, t: '#ffffff' }),
    walk: [
      ['.oo.............',
       'omlo............',
       'ommmooo.........',
       'omemmmmooooooo..',
       'nmmmmmmmmmmmmmoo',
       'otoommmmmmmmmmmo',
       '...oMmmmmmmmMMlo',
       '...oMo.oMo.oMo..',
       '...oo..oo..oo...'],
      ['.oo.............',
       'omlo............',
       'ommmooo.........',
       'omemmmmooooooo.o',
       'nmmmmmmmmmmmmmmo',
       'otoommmmmmmmmmo.',
       '...oMmmmmmmmMMo.',
       '..oMo...oMo.oMo.',
       '..oo....oo...oo.'],
    ],
    attack: [
      ['.oo.............',
       'omlo............',
       'ommmooo.........',
       'omemmmmooooooo..',
       'nmmmmmmmmmmmmmoo',
       'o.ommmmmmmmmmmmo',
       'otoMMmmmmmmmMMlo',
       'oo.oMo.oMo.oMo..',
       '...oo..oo..oo...'],
    ],
  },
  // Snow: a hulking yeti.
  yeti: {
    pal: (c) => ({ ...base(c), f: '#6a8aa8', e: '#ffe040', t: '#ffffff' }),
    walk: [
      ['.....oooooo.....',
       '....ommmmmmo....',
       '...ommffffmmo...',
       '...omfeffefmo...',
       '...omfftttfmo...',
       '..oommmmmmmmoo..',
       '.ommmmmmmmmmmmo.',
       'ommommmmmmmmommo',
       'ommommmmmmmmommo',
       'offoommmmmmooffo',
       '.oo.oMmmmmMo.oo.',
       '....oMmo.oMmo...',
       '...ommmo.ommmo..',
       '...ooooo.ooooo..'],
      ['.....oooooo.....',
       '....ommmmmmo....',
       '...ommffffmmo...',
       '...omfeffefmo...',
       '...omfftttfmo...',
       '..oommmmmmmmoo..',
       '.ommmmmmmmmmmmo.',
       'ommommmmmmmmommo',
       'ommommmmmmmmommo',
       'offoommmmmmooffo',
       '.oo.oMmmmmMo.oo.',
       '...oMmo..oMmo...',
       '..ommmo..ommmo..',
       '..ooooo..ooooo..'],
    ],
    attack: [
      ['.oo..oooooo..oo.',
       'offoommmmmmooffo',
       'ommoommffffmommo',
       '.ommomfeffefmmo.',
       '..ommmfftttfmo..',
       '..oommmmmmmmoo..',
       '...ommmmmmmmo...',
       '...ommmmmmmmo...',
       '...ommmmmmmmo...',
       '...oommmmmmoo...',
       '....oMmmmmMo....',
       '....oMmo.oMmo...',
       '...ommmo.ommmo..',
       '...ooooo.ooooo..'],
    ],
  },
  // Ashlands: a winged fire imp that hurls fireballs.
  imp: {
    pal: (c) => ({ ...base(c), h: '#ffd24a', e: '#ffe040', w: shadeHex(c, -0.45) }),
    walk: [
      ['o..o....o..o',
       'ow.oh..ho.wo',
       'oww.ommo.wwo',
       '.owwmememwo.',
       '..owmmmmwo..',
       '...ommmmo...',
       '..omMmmMmo..',
       '...om..mo...',
       '...o....o...'],
      ['...o....o...',
       '...oh..ho...',
       '....ommo....',
       'ooowmememwoo',
       'owwwmmmmwwwo',
       '.ooommmmooo.',
       '..omMmmMmo..',
       '...om..mo...',
       '...o....o...'],
    ],
    attack: [
      ['o..o....ohho',
       'ow.oh..hohho',
       'oww.ommo.oo.',
       '.owwmememo..',
       '..owmmmmmo..',
       '...ommmmo...',
       '..omMmmMmo..',
       '...om..mo...',
       '...o....o...'],
    ],
  },
  // Stormpeaks: a rock golem with glowing seams.
  golem: {
    pal: (c) => ({ ...base(c), g: '#ffe45c', d: shadeHex(c, -0.5) }),
    walk: [
      ['....oooooo....',
       '...ommmmmmo...',
       '...omgmmgmo...',
       '..oommmmmmoo..',
       '.ommMmmgmmMmo.',
       'ommmomgggmommo',
       'ommmommmmmommo',
       'oddoommgmmoddo',
       '.oo.oMmmmMo.oo',
       '...oMmo.oMmo..',
       '..ommmo.ommmo.',
       '..ooooo.ooooo.'],
      ['....oooooo....',
       '...ommmmmmo...',
       '...omgmmgmo...',
       '..oommmmmmoo..',
       '.ommMmmgmmMmo.',
       'ommmomgggmommo',
       'ommmommmmmommo',
       'oddoommgmmoddo',
       '.oo.oMmmmMo.oo',
       '..oMmo..oMmo..',
       '.ommmo..ommmo.',
       '.ooooo..ooooo.'],
    ],
    attack: [
      ['.oo.oooooo.oo.',
       'oddoommmmmoddo',
       'ommoomgmmgmomo',
       '.omoommmmmmoo.',
       '..omMmmgmmMmo.',
       '..ommmgggmmo..',
       '..ommmmmmmmo..',
       '..oommmgmmoo..',
       '...oMmmmmMo...',
       '...oMmo.oMmo..',
       '..ommmo.ommmo.',
       '..ooooo.ooooo.'],
    ],
  },
  // Stormpeaks: a diving harpy-hawk.
  harpy: {
    pal: (c) => ({ ...base(c), h: '#f4e8c8', y: '#ffd24a', e: O }),
    walk: [
      ['oo..........oo',
       'omo..oooo..omo',
       'ommoohhhhoommo',
       '.ommhehhehmmo.',
       '..omhhyyhhmo..',
       '...ommhhmmo...',
       '....oMmmMo....',
       '....oyo.yo....',
       '....o...o.....'],
      ['..............',
       '.....oooo.....',
       '....ohhhho....',
       'oooomheehmoooo',
       'ommmmhyyhmmmmo',
       '.oMmmmhhmmmMo.',
       '..ooooMMoooo..',
       '....oyo.yo....',
       '....o...o.....'],
    ],
  },
  // Voidreach: a floating eye with tendrils.
  eye: {
    pal: (c) => ({ ...base(c), w: '#f3ecdc', p: '#ff3a6a', k: O }),
    walk: [
      ['...oooooo...',
       '..owwwwwwo..',
       '.owwwmmwwwo.',
       '.owwmkkmwwo.',
       '.owwmkkmwwo.',
       '.owwwmmwwwo.',
       '..owwpwwwo..',
       '...oooooo...',
       '..om.om.mo..',
       '.om..om..mo.',
       '..o...o..o..'],
      ['...oooooo...',
       '..owwwwwwo..',
       '.owwwmmwwwo.',
       '.owwmkkmwwo.',
       '.owwmkkmwwo.',
       '.owwwmmwwwo.',
       '..owwwpwwo..',
       '...oooooo...',
       '...mo.om.om.',
       '..mo..mo..mo',
       '...o...o..o.'],
    ],
    attack: [
      ['...oooooo...',
       '..owwwwwwo..',
       '.owwmmmmwwo.',
       '.owmmppmmwo.',
       '.owmmppmmwo.',
       '.owwmmmmwwo.',
       '..owwwwwwo..',
       '...oooooo...',
       '.om..om..mo.',
       'om...om...mo',
       '.o...o....o.'],
    ],
  },
  // Voidreach: a hooded shade that blinks behind you.
  shade: {
    pal: (c) => ({ ...base(c), e: '#cdb2ff', d: shadeHex(c, -0.5) }),
    walk: [
      ['....oooo....',
       '...ommmmo...',
       '..ommddmmo..',
       '..omdedemo..',
       '..omddddmo..',
       '.oommmmmmoo.',
       'ommmmmmmmmmo',
       '.ommmmmmmmo.',
       '..ommmmmmo..',
       '..omMmmMmo..',
       '...oMo.oMo..',
       '....o...o...'],
      ['....oooo....',
       '...ommmmo...',
       '..ommddmmo..',
       '..omdedemo..',
       '..omddddmo..',
       '.oommmmmmoo.',
       'ommmmmmmmmmo',
       '.ommmmmmmmo.',
       '..ommmmmmo..',
       '..oMmmmMmo..',
       '..oMo.oMo...',
       '...o...o....'],
    ],
  },
  // Sunken Isles: a crab that scuttles sideways.
  crab: {
    pal: (c) => ({ ...base(c), e: O, w: '#ffffff' }),
    walk: [
      ['.oo........oo.',
       'ommo......ommo',
       'omo........omo',
       '.omo.o..o.omo.',
       '..ooowoowooo..',
       '..ommmmmmmmo..',
       '.omlmmmmmmlmo.',
       '.oMmmmmmmmmMo.',
       'o.oMMMMMMMMo.o',
       '.o.o.o..o.o.o.'],
      ['.oo........oo.',
       'ommo......ommo',
       'omo........omo',
       '.omo.o..o.omo.',
       '..ooowoowooo..',
       '..ommmmmmmmo..',
       '.omlmmmmmmlmo.',
       '.oMmmmmmmmmMo.',
       '..oMMMMMMMMo..',
       'o.o.o....o.o.o'],
    ],
    attack: [
      ['oo..........oo',
       'mmo........omm',
       'oommo....ommoo',
       '..omo.o..omo..',
       '..ooowoowooo..',
       '..ommmmmmmmo..',
       '.omlmmmmmmlmo.',
       '.oMmmmmmmmmMo.',
       'o.oMMMMMMMMo.o',
       '.o.o.o..o.o.o.'],
    ],
  },
};

// --- Pals ------------------------------------------------------------------------------
// Friendly companions: walk, idle, attack (bite / zap / headbutt) and a
// curled-up nap for when they are knocked out.
const EMPTY10 = '..........';
const EMPTY12 = '............';

const PALS = {
  mossling: {
    pal: (c) => ({ ...base(c), l: '#c8f59a', g: '#3a8a3a', w: '#ffffff', r: '#ff8aa0' }),
    walk: [
      ['....oo....', '...olgo...', '..oolooo..', '.ommmmmmo.', 'ommmmmwkmo',
       'ommmmmmmmo', 'oMmmmmrmMo', '.oMMMMMMo.', '.oMo..oMo.', '.oo....oo.'],
      ['....oo....', '...olgo...', '..oolooo..', '.ommmmmmo.', 'ommmmmwkmo',
       'ommmmmmmmo', 'oMmmmmrmMo', '.oMMMMMMo.', '..oMooMo..', '..oo..oo..'],
    ],
    idle: [
      ['....oo....', '...olgo...', '..oolooo..', '.ommmmmmo.', 'ommmmmwkmo',
       'ommmmmmmmo', 'oMmmmmrmMo', '.oMMMMMMo.', '.oMo..oMo.', '.oo....oo.'],
      ['.....oo...', '...oglo...', '..oolooo..', '.ommmmmmo.', 'ommmmmoomo',
       'ommmmmmmmo', 'oMmmmmrmMo', '.oMMMMMMo.', '.oMo..oMo.', '.oo....oo.'],
    ],
    attack: [
      ['.....oo...', '....olgo..', '...oolooo.', '..ommmmmmo', '.ommmmmwko',
       '.ommmmmmmo', '.oMmmmmooo', '..oMMMMMo.', '.oMo..oMo.', '.oo....oo.'],
    ],
    sleep: [
      [EMPTY10, EMPTY10, EMPTY10, '....oo....', '..oolgoo..', '.ommmmmmo.',
       'ommmmmoomo', 'oMmmmmmmMo', '.oMMMMMMo.', '..oooooo..'],
    ],
  },
  emberpup: {
    pal: (c) => ({ ...base(c), e: O, n: O, h: '#ffd24a', y: '#ffffff', t: '#ffffff' }),
    walk: [
      ['.........oo.', '.h......omlo', 'hyh..oooommo', '.hyoommmmmeo',
       '..ommmmmmmmn', '..oMmmmmmMoo', '..oMo.oMo...', '..oo..oo....'],
      ['h........oo.', '.hh.....omlo', 'hyh..oooommo', '.hyoommmmmeo',
       '..ommmmmmmmn', '..oMmmmmmMoo', '.oMo...oMo..', '.oo....oo...'],
    ],
    idle: [
      ['.........oo.', '.h......omlo', 'hyh..oooommo', '.hyoommmmmeo',
       '..ommmmmmmmn', '..oMmmmmmMoo', '..oMo.oMo...', '..oo..oo....'],
      ['h........oo.', '.hh.....omlo', 'hyh..oooommo', '.hyoommmmmeo',
       '..ommmmmmmmn', '..oMmmmmmMoo', '..oMo.oMo...', '..oo..oo....'],
    ],
    attack: [
      ['.........oo.', '.h......omlo', 'hyh..oooommo', '.hyoommmmmeo',
       '..ommmmmmmoo', '..oMmmmmmMot', '.oMo...oMo..', '.oo....oo...'],
    ],
    sleep: [
      [EMPTY12, EMPTY12, EMPTY12, '.....oooo...', '..oooommmoo.', '.hommmmmmmmo',
       'hyoMmmmmmooo', '.hoooooooooo'],
    ],
  },
  glimmerfox: {
    pal: (c) => ({ ...base(c), w: '#ffffff', e: O, n: O, z: '#fff27a' }),
    walk: [
      ['.........o.o', '........omom', 'ww......ommo', 'wlo..oooomeo', '.llooommmmmn',
       '.ollmmmmmmwo', '..oMmmmmmMo.', '..oMo..oMo..', '..oo...oo...'],
      ['.........o.o', '........omom', 'ww......ommo', 'wlo..oooomeo', '.llooommmmmn',
       '.ollmmmmmmwo', '..oMmmmmmMo.', '.oMo....oMo.', '.oo.....oo..'],
    ],
    idle: [
      ['.........o.o', '........omom', 'ww......ommo', 'wlo..oooomeo', '.llooommmmmn',
       '.ollmmmmmmwo', '..oMmmmmmMo.', '..oMo..oMo..', '..oo...oo...'],
      ['.........o.o', '........omom', '.ww.....ommo', 'wwlo.oooomeo', '.llooommmmmn',
       '.ollmmmmmmwo', '..oMmmmmmMo.', '..oMo..oMo..', '..oo...oo...'],
    ],
    attack: [
      ['.........o.o', '........omom', 'zz......ommo', 'zlo..oooomzo', '.llooommmmmn',
       '.ollmmmmmmwo', '..oMmmmmmMo.', '..oMo..oMo..', '..oo...oo...'],
    ],
    sleep: [
      [EMPTY12, EMPTY12, EMPTY12, EMPTY12, '....ooooo...', '..oommmmmoo.',
       '.wlmmmmmmooo', 'wwlMMMMMMMo.', '.ooooooooo..'],
    ],
  },
};

const cache = new Map();

/** Does this creature kind have animated frames? */
export function hasCreature(kind) {
  return Object.hasOwn(CREATURES, kind);
}

/**
 * Animated sprite set for a creature: { walk: {right, left}, idle, attack,
 * flash } where each has arrays of canvases. Missing sets fall back to walk.
 */
export function creatureSprites(kind, color) {
  const key = `${kind}:${color}`;
  let s = cache.get(key);
  if (s) return s;
  const def = CREATURES[kind] ?? CREATURES.slime;
  const pal = def.pal(color);
  const make = (maps) => {
    const drawn = maps.map((m) => spriteFromMap(m, pal));
    const mirrored = drawn.map(flipped);
    return def.facesLeft ? { right: mirrored, left: drawn } : { right: drawn, left: mirrored };
  };
  const walk = make(def.walk ?? def.idle);
  s = {
    walk,
    idle: def.idle ? make(def.idle) : walk,
    attack: def.attack ? make(def.attack) : walk,
    flash: silhouette(walk.right[0]),
  };
  // Legacy fields (sprite size, simple uses).
  s.right = walk.right[0];
  s.left = walk.left[0];
  cache.set(key, s);
  return s;
}

/** Every creature with animation (for tests and the bestiary). */
export const CREATURE_KINDS = Object.keys(CREATURES);
export const PAL_KINDS = Object.keys(PALS);

/** The raw frame maps and palette of a creature or pal (for tests). */
export function frameMaps(kind) {
  return CREATURES[kind] ?? PALS[kind] ?? null;
}

/** Animated pal sprites: { walk, idle, attack, sleep } (each { right, left }). */
export function palSprites(species, color) {
  const key = `pal:${species}:${color}`;
  let s = cache.get(key);
  if (s) return s;
  const def = PALS[species] ?? PALS.mossling;
  const pal = def.pal(color);
  const make = (maps) => {
    const right = maps.map((m) => spriteFromMap(m, pal));
    return { right, left: right.map(flipped) };
  };
  s = { walk: make(def.walk), idle: make(def.idle), attack: make(def.attack), sleep: make(def.sleep) };
  cache.set(key, s);
  return s;
}
