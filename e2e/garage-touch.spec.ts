/**
 * Browser flows for the garage, the music slider and the touch controls.
 *
 * SigDRIFT has no accounts: a "player" is what is in localStorage. Two seeded players stand in for test users:
 *   NEW_PLAYER  has finished nothing (only the stock car)
 *   VETERAN     has finished levels 1-3 (the Viper is unlocked, the Brute is not)
 * Each test starts from a fresh browser context with its player written before the page loads.
 */
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

type Seed = Record<string, unknown>;

const NEW_PLAYER: Seed = { 'sigdrift:howToSeen': true };
const VETERAN: Seed = { 'sigdrift:howToSeen': true, 'sigdrift:completedLevels': ['L1', 'L2', 'L3'] };

/** Opens the game as `player` and goes from the title to the main menu. */
async function openAs(page: Page, player: Seed): Promise<void> {
  await page.addInitScript((seed) => {
    // Seed once per tab, so a reload inside the test keeps whatever the test changed.
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.clear();
    for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, JSON.stringify(value));
  }, player);
  await page.goto('/');
  await page.locator('.sd-press').click();
  await expect(page.locator('[data-key="garage"]')).toBeVisible();
}

function car(page: Page, id: string) {
  return page.locator(`.sd-car[data-key="${id}"]`);
}

/** What the running game is actually driving with. */
async function gameCar(page: Page): Promise<{ mass: number; speed: number }> {
  return page.evaluate(() => {
    const hook = (window as unknown as { __sigdrift: { world: { params: { mass: number }; car: { speed: number } } } }).__sigdrift;
    return { mass: hook.world.params.mass, speed: hook.world.car.speed };
  });
}

test.describe('garage', () => {
  test('a veteran picks the Viper and drives level 1 with it', async ({ page }) => {
    await openAs(page, VETERAN);
    await page.locator('[data-key="garage"]').click();
    await expect(car(page, 'phantom')).toHaveAttribute('aria-pressed', 'true');
    await expect(car(page, 'brute')).toHaveClass(/is-locked/);
    await expect(car(page, 'ronin')).not.toHaveClass(/is-locked/);
    await expect(page.locator('.sd-car')).toHaveCount(6);

    await car(page, 'viper').click();
    await expect(car(page, 'viper')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => localStorage.getItem('sigdrift:car'))).toBe('"viper"');
    expect((await gameCar(page)).mass).toBe(880);

    await page.locator('.sd-btn-back').click();
    await page.locator('[data-key="play"]').click();
    await page.locator('.sd-card[data-key="levels"]').click();
    await page.locator('.sd-card[data-key="L1"]').click();
    await expect(page.locator('.sd-menu')).toHaveClass(/sd-hidden/);
    expect((await gameCar(page)).mass).toBe(880);

    // The pick survives a reload.
    await page.reload();
    await page.locator('.sd-press').click();
    await page.locator('[data-key="garage"]').click();
    await expect(car(page, 'viper')).toHaveAttribute('aria-pressed', 'true');
  });

  test('a new player cannot take a locked car, not even by editing storage', async ({ page }) => {
    await openAs(page, NEW_PLAYER);
    await page.locator('[data-key="garage"]').click();
    await car(page, 'brute').click();
    await expect(car(page, 'phantom')).toHaveAttribute('aria-pressed', 'true');
    await expect(car(page, 'brute')).toHaveAttribute('aria-pressed', 'false');

    await page.evaluate(() => localStorage.setItem('sigdrift:car', '"brute"'));
    await page.reload();
    await page.locator('.sd-press').click();
    expect((await gameCar(page)).mass).toBe(1000);
    await page.locator('[data-key="garage"]').click();
    await expect(car(page, 'phantom')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('settings', () => {
  test('the music slider is saved separately from the volume', async ({ page }) => {
    await openAs(page, NEW_PLAYER);
    await page.locator('[data-key="settings"]').click();
    const music = page.getByRole('slider', { name: 'Music' });
    await music.fill('30');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('sigdrift:settings') ?? '{}'));
    expect(saved.musicVolume).toBe(0.3);
    expect(saved.volume).toBe(0.7);
  });
});

test.describe('touch controls', () => {
  test('show while driving on a phone and drive the car', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'phone only');
    await openAs(page, NEW_PLAYER);
    const touch = page.locator('.sd-touch');
    await expect(touch).toHaveClass(/sd-hidden/);

    await page.locator('[data-key="play"]').click();
    await page.locator('.sd-card[data-key="levels"]').click();
    await page.locator('.sd-card[data-key="L1"]').click();
    await expect(touch).not.toHaveClass(/sd-hidden/);
    await expect(page.locator('.sd-touch-gas')).toBeVisible();

    // Hold GAS through the countdown and a little beyond.
    await page.locator('.sd-touch-gas').dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 11, isPrimary: true });
    // Software rendering runs slowly, so wait for the speed rather than for a fixed time.
    await expect.poll(async () => (await gameCar(page)).speed, { timeout: 20_000 }).toBeGreaterThan(5);
    await page.locator('.sd-touch-gas').dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 11 });

    // Pause hides the controls and opens the pause menu.
    await page.locator('.sd-touch-pause').dispatchEvent('pointerdown', { pointerType: 'touch', pointerId: 12 });
    await expect(page.locator('.sd-menu')).not.toHaveClass(/sd-hidden/);
    await expect(touch).toHaveClass(/sd-hidden/);
  });

  test('stay away on a desktop', async ({ page, isMobile }) => {
    test.skip(isMobile, 'desktop only');
    await openAs(page, NEW_PLAYER);
    await page.locator('[data-key="play"]').click();
    await page.locator('.sd-card[data-key="levels"]').click();
    await page.locator('.sd-card[data-key="L1"]').click();
    await expect(page.locator('.sd-menu')).toHaveClass(/sd-hidden/);
    await expect(page.locator('.sd-touch')).toHaveClass(/sd-hidden/);
  });
});
