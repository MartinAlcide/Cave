# Livre de cave

Inventaire de bouteilles, CSV, carte des vins/PDF et PWA hors ligne. La page et ses composants existants restent dans `index.html`. Seules la persistance et la synchronisation sont regroupées dans `src/`.

## Build et tests

Node.js 22 ou plus récent, npm et Python 3 pour le serveur de test navigateur.

```sh
npm ci
npm test
npm run build
npx playwright install chromium
npm run test:browser
python3 -m http.server 4173 --directory dist
```

Ouvrir `http://localhost:4173`. Déployer **le contenu de `dist/`**, pas les sources, sur un hébergement HTTPS statique, éventuellement sous `/Cave/`. Aucun backend, Effect ou outil de build du framework n’est nécessaire. Le client ID est injecté par esbuild. Sans ID, la cave locale fonctionne et affiche « Google Drive non configuré ».

## Configuration Google manuelle

1. Dans [Google Cloud Console](https://console.cloud.google.com/), créer/sélectionner un projet et activer **Google Drive API**.
2. Configurer l’écran de consentement OAuth. En mode test, ajouter les comptes de test. Autorisations : `https://www.googleapis.com/auth/drive.appdata` et `openid` (pour identifier le compte, sans demander son adresse email).
3. Créer un client OAuth **Application Web**. Ajouter les **origines JavaScript autorisées**, par exemple `http://localhost:4173` et `https://samuelbriole.github.io`. Une origine n’inclut ni chemin `/Cave/` ni slash final. Le modèle de jeton GIS utilise une popup, sans secret client ni URI de redirection côté serveur.
4. Construire et déployer :

   ```sh
   GOOGLE_CLIENT_ID="votre-id.apps.googleusercontent.com" npm run build
   ```

   Le client ID est public, ce n’est pas un secret. Ne jamais ajouter de secret OAuth ou de jeton au dépôt. Les deux appareils doivent utiliser le même client ID et le même compte Google.

5. Cliquer **Connecter Google Drive**, autoriser les scopes, puis **Synchroniser**. La connexion seule ne synchronise pas. Si la popup est bloquée, l’autoriser et réessayer. Aucun identifiant Google réel n’est fourni dans cette PR ; ces étapes et le test réel restent à effectuer.

Les fichiers du connecteur sont dans `appDataFolder`, sous `cave-v1`, invisibles dans « Mon Drive ». Le scope `drive.appdata` limite les accès aux données de cette application. Le jeton reste uniquement en mémoire et n’est jamais placé dans localStorage, IndexedDB ou le cache PWA. Après rechargement, expiration (avec marge de 30 secondes), révocation ou réponse 401/autorisation insuffisante, reconnecter Google ; aucun refresh token ni renouvellement silencieux. Une erreur de quota n’efface pas la connexion.

**Déconnecter** arrête la synchronisation et révoque le jeton courant, sans effacer la cave locale ou Drive. Une cave locale reste liée au premier compte choisi pour éviter le mélange accidentel de comptes. Le changement de compte n’est pas pris en charge dans cette V1.

## Migration, persistance et conflits

- Au premier lancement, `localStorage['cave-v1']` est validé et importé dans RxDB/Dexie (IndexedDB). La valeur originale reste intacte, et une seconde copie exacte est conservée dans la collection locale `migration`, avec un marqueur durable. Une migration interrompue reprend sans remplacer un document déjà créé. Les données invalides affichent une erreur au lieu d’ouvrir une cave vide ou d’effacer l’original.
- Les éditions, quantités, suppressions/annulations et imports CSV s’enregistrent localement même hors ligne. L’interface observe RxDB, y compris les changements reçus. Aucun appel Drive au démarrage, lors d’une édition ou au retour du réseau.
- Le [connecteur officiel Google Drive RxDB](https://rxdb.info/replication-google-drive.html) gère fichiers, checkpoints, verrous, WAL et détection des conflits. Seul le document `cave` de la collection `cave` est répliqué ; migration et liaison de compte restent locales.
- RxDB 17.6.0 bloque `cancel()` pendant une première réplication `live: false` en erreur. `src/drive.js` compose ses **handlers publics officiels** avec le moteur RxDB standard, actif seulement entre le clic et la fin de la tentative. Ce contournement n’utilise aucune API privée, aucun protocole Drive maison, aucun signaling/WebRTC. Toute erreur arrête les relances du moteur ; une tentative est limitée à deux minutes, attente de choix incluse.
- Pour limiter la PR, ce document contient **la cave entière** au format existant. Le gestionnaire de conflits RxDB attend un choix explicite entre locale et distante, avec date, nombre de bouteilles et contenu consultable, avant remplacement. Deux caves déjà remplies lors de leur première synchronisation peuvent aussi demander ce choix. Annuler conserve les versions. Pas de stratégie « dernière date gagnante ».
- La PWA précache HTML, bundle et manifeste ensemble. Une nouvelle version devient active après fermeture de tous les onglets de l’ancienne version, puis réouverture. Le cache ne contient ni GIS ni réponses Drive.

## Test réel sur deux appareils

Utiliser un compte de test et exporter les deux caves en CSV avant de commencer.

1. Sur A et B, ouvrir le build configuré, connecter le **même compte**. Sur A, ajouter une bouteille puis Synchroniser. Sur B, Synchroniser et vérifier qu’elle apparaît. Vérifier l’absence de dialogue si B était vide.
2. Sur B, passer hors ligne, modifier une quantité, ajouter puis retirer une autre bouteille, tester l’annulation et un import CSV. Fermer/rouvrir la PWA hors ligne : les modifications doivent rester. Vérifier aussi export CSV et aperçu/impression PDF.
3. Revenir en ligne sur B : rien ne doit être envoyé avant Synchroniser. Cliquer, puis Synchroniser sur A et vérifier les données.
4. Partir d’une version synchronisée sur A et B. Hors ligne, modifier la même cave différemment sur les deux appareils. Reconnecter et Synchroniser A, puis B. Sur B, consulter les deux versions : aucun contenu ne doit être remplacé avant le choix. Choisir locale, synchroniser A pour vérifier. Répéter avec distante, puis avec Annuler.
5. Pendant un conflit, modifier encore localement : la nouvelle édition doit rester enregistrée et ne pas être écrasée par une décision devenue obsolète. Refaire une synchronisation si nécessaire.
6. Déconnecter, modifier localement et vérifier l’absence de requêtes Drive. Reconnecter. Tester un jeton expiré/révoqué et une coupure réseau pendant Synchroniser : statut d’erreur, données conservées, reconnexion ou nouveau clic requis.

## Limites de la V1

- Pas de synchronisation automatique, partage, multi-compte, historique distant, fusion bouteille par bouteille ou chiffrement applicatif. Un choix de conflit conserve **une cave entière**, et peut donc perdre les changements de l’autre version. Copier les contenus affichés ou exporter les caves sur chaque appareil avant de choisir.
- Le connecteur RxDB Google Drive est **bêta**, version épinglée dans `package.json`. Les tests utilisent son vrai protocole contre `google-drive-mock`, mais ne remplacent pas le test OAuth et Drive réel sur deux appareils.
- Drive est éventuellement cohérent : si un changement récent n’apparaît pas immédiatement, attendre puis recliquer Synchroniser. Quotas et latence peuvent interrompre une tentative. Une requête déjà envoyée lors d’une coupure/déconnexion peut avoir été appliquée côté Drive ; réconcilier au prochain clic.
- Le connecteur ne sait pas interrompre un handler Drive déjà en cours : après Annuler, Déconnecter ou le délai maximal, une acquisition de verrou déjà engagée peut encore faire des requêtes et appliquer son opération. L’arrêt concerne les nouvelles relances du moteur, pas une annulation transactionnelle côté Drive. Après une erreur, attendre la fin des opérations en vol avant de retenter ; un verrou laissé par un appareil fermé expire après environ une minute.
- Comme toute PWA, IndexedDB peut être évincé par le navigateur, notamment en navigation privée. Garder des exports CSV ; la copie de migration n’est pas une sauvegarde des éditions ultérieures. Le changement d’origine/hébergement crée un autre stockage local et exige un export/import.
