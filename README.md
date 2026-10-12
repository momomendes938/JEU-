# Play Together — UNO en ligne

## Lancer le jeu chez toi
1. Installe Node.js (version LTS, 18 ou plus).
2. Dans le dossier du projet :
   ```bash
   npm install
   npm start
   ```
3. Ouvre http://localhost:3000.

Sur le même Wi-Fi, les téléphones ouvrent `http://IP-DE-TON-PC:3000`.

## Mettre le jeu en ligne (jouer hors Wi-Fi)
Il faut un hébergeur qui garde un serveur Node actif et accepte les WebSockets. Avec **Render** (offre gratuite) :
1. Crée un compte sur https://github.com et un dépôt vide, puis envoie-y ce dossier :
   ```bash
   git init && git add . && git commit -m "UNO"
   git branch -M main
   git remote add origin https://github.com/TON-COMPTE/play-together.git
   git push -u origin main
   ```
2. Sur https://render.com : **New +** → **Blueprint** (ou **Web Service**), choisis ton dépôt. Le fichier `render.yaml` règle tout (build `npm install`, démarrage `npm start`, test de santé `/healthz`).
3. Au bout de quelques minutes tu obtiens une adresse `https://play-together-uno.onrender.com`. Envoie-la à tes amis : HTTPS/WSS est géré par Render.

À savoir sur l'offre gratuite : le serveur s'endort après environ 15 minutes sans visite (le premier chargement prend alors une minute) et les parties en cours sont perdues s'il redémarre, car les salons sont gardés en mémoire.

Autres options : Railway, Fly.io ou n'importe quel serveur avec Docker (`docker build -t uno . && docker run -p 3000:3000 uno`).

## Structure
```
server.js          moteur de jeu, bots et Socket.IO
public/index.html  interface (doit rester dans public/)
Dockerfile, render.yaml   déploiement
```

## Fonctionnalités
- Jeu officiel de 108 cartes, 7 cartes chacun, 2 à 8 joueurs
- Une seule pioche par tour : carte piochée jouable = tu la joues ou tu passes, sinon le tour passe
- +2, Passe, Inversion, Joker, Joker +4 avec bluff et défi, effet de la carte de départ
- Bouton UNO et Contre-UNO (le fautif pioche 2 cartes)
- Manches et points cumulés (numéros = valeur, actions = 20, jokers = 50)
- **Bots** : l'hôte les ajoute depuis le salon (jusqu'à 8 joueurs au total). Ils bluffent, défient parfois un +4 et oublient de temps en temps de crier UNO
- **Sons et vibrations** : sons générés dans le navigateur (carte posée, pioche, ton tour, UNO, victoire). Le bouton 🔊 en haut les coupe
- Reconnexion après rafraîchissement ou coupure, joueur absent passé après 25 s

## Sécurité
- Chaque joueur ne reçoit que sa propre main
- Le serveur vérifie toutes les actions, limite la fréquence par connexion et nettoie les salons inactifs

## Pas encore fait
- Variantes non officielles (7-0, cumul des +2, équipes)
- Tests automatisés dans le dépôt, comptes et statistiques
