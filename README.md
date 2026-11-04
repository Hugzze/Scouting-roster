# Scouting Roster — site de l'équipe

Le même outil que dans Claude, mais hébergé sur un vrai site : chaque directeur crée son compte (e-mail + mot de passe), colle le lien d'une scène, cliquent sur **Remplir les infos**, et les événements, cashprizes et dates se remplissent tout seuls. Si le site ne peut pas être lu, l'outil demande de coller le texte de la page ou d'ajouter des captures d'écran.

**Coût : 0 €** avec les offres gratuites de Cloudflare et de Google (Gemini).

## Comment ça marche

- **Cloudflare Workers** héberge le site (gratuit : 100 000 requêtes par jour).
- **Cloudflare D1** garde les données. Chaque compte a ses propres simulations **et** son propre catalogue d'événements : rien n'est visible d'un compte à l'autre.
- **Gemini** (Google) lit le texte et les captures d'écran pour en sortir les événements.
- **Liquipedia** est lu par leur API officielle (jamais en copiant les pages), avec au maximum 1 lecture toutes les 30 secondes, et les résultats sont gardés 12 h.
- **Comptes personnels** : e-mail + mot de passe (stocké chiffré, jamais en clair). Pour que plusieurs directeurs voient la même chose, créez un compte commun (par exemple avec une adresse du club) et connectez-vous-y tous.

## Mise en ligne depuis un téléphone (sans ordinateur, ≈ 10 minutes)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=URL_DU_DEPOT)

1. Crée une clé Gemini gratuite : https://aistudio.google.com/apikey (bouton **Create API key**), et garde-la sous la main.
2. Touche le bouton ci-dessus. Connecte-toi (ou crée un compte gratuit) à Cloudflare et à GitHub quand on te le demande.
3. Sur la page de configuration, Cloudflare crée tout seul la base de données. Il te demande trois valeurs :
   - **SESSION_SECRET** : une longue phrase au hasard (30 caractères ou plus), que tu n'auras plus jamais à retaper ;
   - **GEMINI_API_KEY** : la clé de l'étape 1 ;
   - **CONTACT** : l'adresse e-mail du club (Liquipedia l'exige pour autoriser la lecture de ses pages).
4. Touche **Create and deploy**. Au bout de quelques minutes, Cloudflare affiche l'adresse du site, du type `https://scouting-roster.TON-COMPTE.workers.dev`.
5. Ouvre l'adresse, touche « Créer un compte » et fais un premier essai.

Les tables de la base se créent toutes seules au premier usage.

### Avec un ordinateur (autre méthode)

Dans le dossier du projet : `npm install`, `npx wrangler login`, puis `npx wrangler secret put SESSION_SECRET`, `npx wrangler secret put GEMINI_API_KEY`, `npx wrangler secret put CONTACT` et `npx wrangler deploy`. La base est créée automatiquement au premier déploiement.

## Au quotidien

- **Mot de passe oublié** : il n'y a pas d'envoi d'e-mail dans la version gratuite, donc pas de lien « mot de passe oublié ». Le compte est à recréer avec une autre adresse (les anciennes données restent liées à l'ancien compte). Dis-le aux directeurs : le mieux est de noter le mot de passe du compte commun dans un gestionnaire de mots de passe.
- **Limites de lectures** : `DAILY_READS` (200 par jour au total) et `DAILY_READS_PER_USER` (20 par compte) dans `wrangler.toml`. À modifier puis `npx wrangler deploy`.
- **Modèle Gemini** : `GEMINI_MODEL` dans `wrangler.toml`. Si Google retire ce modèle, mets le nom du modèle « flash » actuel.
- **Mettre à jour l'outil** : remplace les fichiers, puis `npx wrangler deploy`.

## Points d'attention

- **Gemini gratuit** : Google peut utiliser les données envoyées avec l'offre gratuite pour améliorer ses produits. Ici, ce sont des pages publiques de compétitions et des captures de calendriers ; n'envoie pas de documents confidentiels (contrats, chiffres internes du club). Si ça pose un problème, active la facturation sur le projet Google : les données ne sont alors plus utilisées, et à ce volume le coût reste de quelques centimes par mois.
- **Liquipedia** : les contenus sont sous licence CC-BY-SA ; la source est gardée avec chaque événement. Ne pas réduire l'espacement de 30 s entre lectures.
- **Sécurité** : mots de passe chiffrés (PBKDF2), 10 essais ratés par compte et par heure maximum, 5 créations de compte par heure et par connexion internet. Les données de chaque compte sont isolées côté serveur. Elles ne sont toutefois pas chiffrées pour l'administrateur du compte Cloudflare, qui peut techniquement lire la base : à garder en tête pour des informations sensibles.
- **Compte commun** : si deux personnes modifient la même simulation en même temps, la dernière sauvegarde écrase l'autre. Les changements de l'un apparaissent chez l'autre en 20 secondes environ.
- **Retirés par rapport à la version Claude** : la recherche automatique des réseaux sociaux des joueurs et la recherche du catalogue par nom ; les réseaux se saisissent à la main (étape 4), le catalogue se remplit depuis l'étape 1.
- **Polices** : le design charge les polices Archivo et JetBrains Mono depuis Google Fonts (gratuit).

## Ce qui n'a pas pu être testé avant livraison

Tout a été testé en local contre de faux Gemini / Liquipedia / sites (création de compte, connexion, isolation entre comptes, lecture de liens, pages illisibles, protections contre les adresses internes, limite de tentatives de connexion, interface complète dans un navigateur). Il reste à vérifier une fois en ligne : la lecture réelle de Liquipedia, la réponse réelle de Gemini, et surtout l'envoi de **captures d'écran** à Gemini (offre gratuite). Si l'une de ces étapes échoue, le message d'erreur du site indique la cause ; reviens vers Claude avec ce message.

## Tests en local (facultatif)
Copie `.dev.vars.example` en `.dev.vars`, puis `npx wrangler dev` et ouvre http://127.0.0.1:8787.
