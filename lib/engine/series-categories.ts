/**
 * GENERATED FILE — do not edit by hand. Regenerate with:
 *   npx tsx scripts/build-series-map.ts
 *
 * Series prefix → detector category label, learned from History rows whose
 * Bid Item links to a catalog record — Premier Items (its Fixture Category)
 * or 3rd Party Domestic Items (its linked Product Categories, resolved
 * through the shared taxonomy). Rules live in lib/engine/series-learning.ts.
 *
 * This is the PRODUCTION map, built from the whole corpus. The eval harness
 * does NOT use it — it relearns per leave-one-project-out fold, so that a
 * series learned from one past job (real knowledge for the next bid) cannot
 * be used to score that same job.
 *
 * Source snapshot: fetched 2026-07-29T19:49:10.000Z (9479 history rows)
 * Series learned: 129 (from 653 usable linked rows —
 * 480 Premier-linked, 173 3rd-party-linked;
 * support ≥ 2 rows, agreement ≥ 80%).
 * 90 of them rest on a single project — legitimate for the next
 * bid, and invisible to the eval by construction.
 */

export const SERIES_CATEGORY_MAP: Record<string, string> = {
    "4367oni": "Pendant", // 2/2 rows, 2 projects
    "43848whled30t": "Recessed", // 2/2 rows, 2 projects
    "45574ni": "Vanity", // 2/2 rows, 2 projects
    "4aws": "Linear", // 2/2 rows, 1 project
    "4snled": "Linear", // 2/2 rows, 1 project
    "4snx": "Linear", // 6/6 rows, 1 project
    "4vrvt1": "Linear", // 3/3 rows, 1 project
    "4wnled": "Linear", // 2/2 rows, 1 project
    "700wspit": "Sconce", // 2/2 rows, 1 project
    "75r": "Linear", // 2/2 rows, 1 project
    "aaf121400l30": "Recessed", // 2/2 rows, 1 project
    "ae3rr": "Recessed", // 2/2 rows, 1 project
    "apx6r": "Exit/Emergency", // 4/4 rows, 1 project
    "apxrg": "Exit/Emergency", // 3/3 rows, 1 project
    "arn": "Pendant", // 3/3 rows, 2 projects
    "b003": "Recessed", // 2/2 rows, 1 project
    "blwp4": "Linear", // 4/4 rows, 2 projects
    "bs100led": "Linear", // 5/5 rows, 3 projects
    "bva": "Recessed", // 4/4 rows, 1 project
    "bva002": "Recessed", // 9/9 rows, 1 project
    "cer": "Sconce", // 2/2 rows, 2 projects
    "cite": "Linear", // 2/2 rows, 1 project
    "clx": "Linear", // 13/13 rows, 3 projects
    "clxl48": "Linear", // 6/6 rows, 1 project
    "css": "Linear", // 10/10 rows, 3 projects
    "csvt": "Linear", // 3/3 rows, 3 projects
    "ctl": "Recessed", // 2/2 rows, 1 project
    "dfc11": "Ceiling", // 2/2 rows, 2 projects
    "disc": "Recessed", // 2/2 rows, 1 project
    "downlight": "Recessed", // 8/8 rows, 3 projects
    "drd5s": "Recessed", // 2/2 rows, 1 project
    "drdh": "Recessed", // 2/2 rows, 1 project
    "e26": "Pendant", // 2/2 rows, 1 project
    "eclipse": "Recessed", // 3/3 rows, 1 project
    "eco": "Recessed", // 2/2 rows, 1 project
    "edg": "Exit/Emergency", // 6/6 rows, 1 project
    "efv": "Linear", // 5/5 rows, 1 project
    "egrf0609l30d1wh": "Recessed", // 2/2 rows, 1 project
    "elx": "Exit/Emergency", // 8/8 rows, 3 projects
    "elx400": "Exit/Emergency", // 3/3 rows, 1 project
    "esl": "Linear", // 3/3 rows, 1 project
    "evo2": "Recessed", // 3/3 rows, 1 project
    "expl": "Outdoor", // 2/2 rows, 1 project
    "ezrxteu": "Exit/Emergency", // 2/2 rows, 1 project
    "f896": "Ceiling Fan", // 3/3 rows, 2 projects
    "fem": "Linear", // 4/4 rows, 4 projects
    "fluorescent": "Linear", // 2/2 rows, 1 project
    "fss": "Linear", // 6/6 rows, 2 projects
    "fssez": "Linear", // 4/4 rows, 2 projects
    "fsw440l840": "Linear", // 2/2 rows, 1 project
    "gadfc02": "Ceiling", // 2/2 rows, 1 project
    "grls": "Recessed", // 2/2 rows, 1 project
    "h602102": "Undercabinet", // 9/10 rows, 1 project
    "ic1jb": "Recessed", // 5/5 rows, 1 project
    "ilx": "Exit/Emergency", // 3/3 rows, 1 project
    "jlal": "Recessed", // 2/2 rows, 1 project
    "jsbc": "Recessed", // 7/7 rows, 2 projects
    "jsf": "Recessed", // 3/3 rows, 2 projects
    "kkw1846746": "Ceiling", // 2/2 rows, 1 project
    "l60": "Linear", // 2/2 rows, 1 project
    "lc20rt6": "Recessed", // 4/4 rows, 1 project
    "lcat143500sm": "Linear", // 4/4 rows, 1 project
    "lcmpd7r": "Recessed", // 2/2 rows, 1 project
    "lcs4": "Linear", // 2/2 rows, 1 project
    "ldn6": "Recessed", // 13/13 rows, 2 projects
    "ldn630": "Recessed", // 2/2 rows, 2 projects
    "ldn6sq": "Recessed", // 2/2 rows, 1 project
    "lpx": "Exit/Emergency", // 3/3 rows, 1 project
    "lpx7sd": "Exit/Emergency", // 4/4 rows, 1 project
    "lqm": "Exit/Emergency", // 7/7 rows, 4 projects
    "lvts": "Linear", // 4/4 rows, 3 projects
    "ml07": "Linear", // 4/4 rows, 2 projects
    "mnsl": "Linear", // 2/2 rows, 1 project
    "mps": "Linear", // 6/6 rows, 1 project
    "nlcbc": "Recessed", // 4/4 rows, 1 project
    "nlopac": "Recessed", // 3/3 rows, 2 projects
    "nox43627ww": "Recessed", // 2/2 rows, 1 project
    "npsu": "Undercabinet", // 2/2 rows, 1 project
    "nsw": "Outdoor", // 3/3 rows, 1 project
    "palermo": "Pendant", // 2/2 rows, 1 project
    "pd3106": "Pendant", // 2/2 rows, 1 project
    "petpe": "Exit/Emergency", // 4/4 rows, 1 project
    "r2frdt": "Recessed", // 2/2 rows, 1 project
    "rbs7": "Recessed", // 6/6 rows, 2 projects
    "rfr7": "Recessed", // 6/6 rows, 1 project
    "rirw0512l30entg": "Sconce", // 3/3 rows, 1 project
    "rl677": "Recessed", // 2/2 rows, 2 projects
    "rled": "Linear", // 2/2 rows, 1 project
    "rlem": "Exit/Emergency", // 2/2 rows, 1 project
    "rxl5rw": "Exit/Emergency", // 5/5 rows, 1 project
    "s10r": "Recessed", // 2/2 rows, 1 project
    "s11355": "Pendant", // 4/4 rows, 1 project
    "s21264": "Sconce", // 2/2 rows, 1 project
    "s29331": "Recessed", // 8/8 rows, 1 project
    "s29344": "Recessed", // 4/4 rows, 1 project
    "s5r": "Recessed", // 4/4 rows, 2 projects
    "s7r": "Recessed", // 4/4 rows, 2 projects
    "sbl4": "Linear", // 2/2 rows, 1 project
    "sdl4": "Linear", // 7/7 rows, 1 project
    "sld4": "Linear", // 3/3 rows, 1 project
    "sledskr7": "Recessed", // 4/4 rows, 2 projects
    "slf": "Linear", // 2/2 rows, 2 projects
    "smd6r12930whe": "Recessed", // 2/2 rows, 1 project
    "smd6r6930whe": "Recessed", // 3/3 rows, 1 project
    "smpr": "Recessed", // 6/6 rows, 1 project
    "snled": "Linear", // 3/3 rows, 2 projects
    "spwlex": "Exit/Emergency", // 3/3 rows, 1 project
    "st48": "Linear", // 2/2 rows, 1 project
    "stp48": "Linear", // 2/2 rows, 1 project
    "sw3": "Linear", // 4/4 rows, 1 project
    "swled": "Linear", // 2/2 rows, 1 project
    "swp1212": "Linear", // 2/2 rows, 1 project
    "thinktek": "Recessed", // 2/2 rows, 1 project
    "tlx": "Exit/Emergency", // 4/4 rows, 2 projects
    "trc": "Linear", // 2/2 rows, 1 project
    "tsl9": "Linear", // 6/6 rows, 1 project
    "va4": "Exit/Emergency", // 9/9 rows, 2 projects
    "vap": "Linear", // 3/3 rows, 2 projects
    "vlst4": "Linear", // 4/4 rows, 2 projects
    "vlst4b": "Linear", // 2/2 rows, 1 project
    "vlvt1b": "Linear", // 2/2 rows, 1 project
    "vtsc": "Linear", // 2/2 rows, 1 project
    "wl4": "Linear", // 4/4 rows, 3 projects
    "wlezxteu": "Exit/Emergency", // 2/2 rows, 1 project
    "wlte": "Exit/Emergency", // 4/4 rows, 3 projects
    "wso75l30k": "Sconce", // 2/2 rows, 1 project
    "wtz4": "Linear", // 4/4 rows, 1 project
    "xes2gw": "Exit/Emergency", // 3/3 rows, 1 project
    "zl1d": "Linear", // 4/4 rows, 2 projects
};
