// Layout sweep scenario for the Arena tab (taste:frontend-layout-sweep's sweep.mjs drives it).
//
//   ARENA_PANEL_ORIGIN=https://127.0.0.1:5174 \
//     node <skill>/scripts/sweep.mjs --scenario chrome-test/arena.sweep.mjs --cdp http://127.0.0.1:9333
//
// It reads the runs the arena sidecar behind that origin already holds rather than making any,
// so seed it first: one run with three lanes whose prompt starts "Read README.md" (the
// comparison states), one Terminals-mode run whose prompt starts "Reply with exactly" (what
// `chrome-test/arena-terminals-verify.mjs` starts, with ARENA_KEEP_RUN=1 so it is not deleted),
// plus several more for list volume. Runs whose contestants fail on a spent
// provider quota are as good as any for layout, and free. The debug browser must be started with
// `--ignore-certificate-errors` when the origin's certificate names a host other than 127.0.0.1.

const ORIGIN = process.env.ARENA_PANEL_ORIGIN ?? 'https://127.0.0.1:5174';
const LONG_PROMPT = `${'Refactor the widget module so every exported constant is documented. '.repeat(6)}` +
  'antidisestablishmentarianism-and-a-very-long-unbroken-identifier-to-test-wrapping-behaviour';

/** Clicks the newest run whose row (its name, then its prompt) holds `head`, then waits for its lanes. */
function openRun(head) {
  return `(async () => {
    const row = [...document.querySelectorAll('nav[aria-label="Arena runs"] li button')]
      .find((one) => one.textContent.includes(${JSON.stringify(head)}));
    if (!row) throw new Error('no run starting ' + ${JSON.stringify(head)});
    row.click();
    for (let i = 0; i < 100 && !document.querySelector('[aria-label$=" facts"]'); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return !!document.querySelector('[aria-label$=" facts"]');
  })()`;
}

function chooseView(name) {
  return `(() => {
    const tab = [...document.querySelectorAll('[role=tab]')].find((one) => one.textContent.startsWith(${JSON.stringify(name)}));
    tab.click();
    return true;
  })()`;
}

export default async function ({ page, sweep }) {
  // A fresh load of the tab: the switcher pass presses every control on the page after a state,
  // the app's own header included, and an overlay one of those opens would otherwise sit over the
  // next state and be judged as part of it.
  const fresh = async () => {
    await page.goto(`${ORIGIN}/?entry=arena`);
    await page.waitFor(`document.querySelector('nav[aria-label="Arena runs"] li')`, { timeout: 20000 });
  };
  await fresh();
  await sweep('composer, default lineup');

  await sweep('composer, four lanes and a long draft', {
    setup: async () => {
      // Each state puts the page where it needs it: the switcher pass clicks through the rail's
      // rows after every state, so the page is wherever that left it.
      await page.click('text=New run');
      await page.settle();
      await page.click('text=Add a contestant');
      await page.click('text=Add a contestant');
      await page.fill('textarea[aria-label="Prompt every contestant gets"]', LONG_PROMPT);
      await page.fill('input[aria-label="Repository the contestants work in"]', `/Users/somebody/${'deeply/nested/'.repeat(6)}repository`);
    },
  });

  await sweep('three-lane run, sessions', {
    // The activity feed pins the turn's prompt over the top of a transcript scrolled past it
    // (ActivityFeed's absolute header); that layering is the feed's on purpose, on every surface
    // that renders a session, and is left out of this state's judgment.
    ignore: '.absolute.inset-x-0.top-0.z-20',
    setup: async () => {
      await fresh();
      await page.waitFor(openRun('Read README.md'), { timeout: 10000 });
      await page.sleep(2500);
    },
  });

  await sweep('three-lane run, files', {
    setup: async () => {
      await fresh();
      await page.waitFor(openRun('Read README.md'), { timeout: 10000 });
      await page.evaluate(chooseView('Files'));
      await page.settle();
    },
  });

  await sweep('three-lane run, diffs', {
    setup: async () => {
      await fresh();
      await page.waitFor(openRun('Read README.md'), { timeout: 10000 });
      await page.evaluate(chooseView('Diffs'));
      await page.sleep(1200);
    },
  });

  // Seed: one run in the Terminals mode whose prompt starts "Reply with exactly", closed, with
  // its panes still open (they last until the run is deleted).
  await sweep('terminals run, sessions', {
    // xterm draws each lane's pane at the pane's own width and scales its type to fit; what is
    // inside it is the harness's screen, not this page's layout.
    ignore: '.absolute.inset-x-0.top-0.z-20, .xterm',
    setup: async () => {
      await fresh();
      await page.waitFor(openRun('Reply with exactly'), { timeout: 10000 });
      await page.evaluate(chooseView('Sessions'));
      await page.sleep(3000);
    },
  });

  // Seed: any Terminals-mode run with its lanes open and no prompt yet. The lanes take the height
  // under the header, so each composer and its pane sit on screen with the empty feed above them.
  await sweep('terminals run waiting for its prompt, sessions', {
    ignore: '.xterm',
    setup: async () => {
      await fresh();
      await page.waitFor(openRun('Waiting for a prompt'), { timeout: 10000 });
      await page.evaluate(chooseView('Sessions'));
      await page.sleep(3000);
    },
  });

  await sweep('one-lane failed run, sessions', {
    setup: async () => {
      await fresh();
      await page.waitFor(openRun('Volume run 1'), { timeout: 10000 });
      await page.evaluate(chooseView('Sessions'));
      await page.sleep(1500);
    },
  });
}
