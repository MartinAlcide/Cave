import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const original = JSON.stringify({ bottles: [{ id: 'wine-1', color: 'rouge', pays: 'France',
  region: 'Bourgogne', appellation: 'Volnay', domaine: 'Domaine test', cuvee: '', millesime: '2020',
  quantity: 3, format: 75, location: 'Casier A' }], lastModified: 123456789 });

test('migration, modification et redémarrage de la PWA entièrement hors ligne, CSV et PDF', async ({ page, context }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(raw => {
    if (!localStorage.getItem('cave-v1')) localStorage.setItem('cave-v1', raw);
  }, original);
  await page.goto('/');
  await expect(page.getByText('Domaine test', { exact: true })).toBeVisible();
  await expect(page.getByText('Nombre total de bouteilles : 3')).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });
  await context.setOffline(true);
  await page.getByText('Domaine test', { exact: true }).click();
  await page.getByRole('button', { name: 'Augmenter la quantité', exact: true }).click();
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByText('Nombre total de bouteilles : 4')).toBeVisible();
  await expect(page.getByText('Enregistrement local…', { exact: true })).toBeHidden();
  // Wait for the durable write by reloading, not just checking optimistic UI state.
  await page.reload();
  await expect(page.getByText('Nombre total de bouteilles : 4')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('cave-v1'))).toBe(original);

  await page.getByRole('button', { name: 'exporter', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: /Tableur/ }).click();
  const exported = await download;
  expect(exported.suggestedFilename()).toMatch(/\.csv$/);
  await page.locator('input[type=file]').setInputFiles({ name: 'cave.csv', mimeType: 'text/csv',
    buffer: await readFile(await exported.path()) });
  await page.getByRole('button', { name: /^Fusionner/ }).click();
  await expect(page.getByText('Nombre total de bouteilles : 8')).toBeVisible();
  await expect(page.getByText('Enregistrement local…', { exact: true })).toBeHidden();
  await page.reload();
  await expect(page.getByText('Nombre total de bouteilles : 8')).toBeVisible();
  await page.getByRole('button', { name: 'exporter', exact: true }).click();
  await page.getByRole('button', { name: /Carte des vins/ }).click();
  await page.getByRole('button', { name: 'Par type de vin', exact: true }).click();
  await expect(page.getByRole('button', { name: /Imprimer/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('deux onglets : une édition de formulaire obsolète exige un choix avant écrasement', async ({ page, context }) => {
  await page.addInitScript(raw => localStorage.setItem('cave-v1', raw), original);
  await page.goto('/');
  await expect(page.getByText('Domaine test', { exact: true })).toBeVisible();
  const second = await context.newPage();
  await second.goto('/');
  await second.getByText('Domaine test', { exact: true }).click();

  await page.getByText('Domaine test', { exact: true }).click();
  await page.getByRole('button', { name: 'Augmenter la quantité', exact: true }).click();
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByText('Enregistrement local…', { exact: true })).toBeHidden();
  await expect(second.getByText('Nombre total de bouteilles : 4')).toBeVisible();

  // The second tab's form still contains its original draft (quantity 3).
  await second.getByRole('button', { name: 'Augmenter la quantité', exact: true }).click();
  await second.getByRole('button', { name: 'Augmenter la quantité', exact: true }).click();
  await second.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(second.getByRole('region', { name: 'Conflit de synchronisation' })).toBeVisible();
  await expect(page.getByText('Nombre total de bouteilles : 4')).toBeVisible();
  await second.getByRole('button', { name: 'Garder la version enregistrée', exact: true }).click();
  await expect(second.getByText('Nombre total de bouteilles : 4')).toBeVisible();
  await expect(second.getByText('Enregistrement local…', { exact: true })).toBeHidden();
});
