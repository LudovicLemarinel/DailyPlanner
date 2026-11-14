# Daily Planner

Intégration Home Assistant + carte Lovelace pour **planifier une ou plusieurs actions à une heure donnée, certains jours de la semaine**, avec un interrupteur pour activer / désactiver chaque programme.

![HACS](https://img.shields.io/badge/HACS-Custom-orange.svg)

## Fonctionnement

- Les programmes sont **stockés et exécutés par Home Assistant** (côté serveur) : ils se déclenchent même si aucun tableau de bord n'est ouvert, et survivent aux redémarrages.
- Chaque programme crée une entité `switch.daily_planner_<id>` : allumée = programme actif. Elle est utilisable dans vos automatisations, scripts, etc. Ses attributs indiquent l'heure, les jours, la prochaine et la dernière exécution.
- La carte **Daily Planner** est fournie par l'intégration (aucune ressource à ajouter à la main).

## Installation

### Via HACS (recommandé)

1. HACS › menu ⋮ › **Dépôts personnalisés** › ajouter `https://github.com/LudovicLemarinel/DailyPlanner`, catégorie **Intégration**.
2. Rechercher **Daily Planner** dans HACS, le télécharger.
3. Redémarrer Home Assistant.
4. **Paramètres › Appareils et services › Ajouter une intégration › Daily Planner**.

### Manuelle

Copier `custom_components/daily_planner` dans le dossier `config/custom_components/` de Home Assistant, redémarrer, puis ajouter l'intégration comme ci-dessus.

> Home Assistant 2024.8 ou plus récent est requis.

## Utilisation de la carte

Sur un tableau de bord : **Modifier › Ajouter une carte › Daily Planner**. Chaque carte pilote un programme :

- **Nom** : cliquer sur le titre pour le modifier.
- **Interrupteur** : active / désactive le programme (immédiat).
- **Heure** et **jours** (L M M J V S D).
- **Actions** › *Modifier* :
  - *Action* : un service (`light.turn_on`, `switch.turn_off`, `script.mon_script`, `scene.turn_on`…), les entités ciblées, et des données JSON optionnelles (`{"brightness_pct": 50}`).
  - *Avancé (JSON)* : n'importe quelle action Home Assistant au format JSON (`{"delay": "00:01:00"}`, conditions, etc.).
- **Enregistrer**, **Tester** (exécute les actions tout de suite) et la corbeille pour supprimer le programme.

Configuration YAML de la carte :

```yaml
type: custom:daily-planner-card
schedule_id: reveil      # identifiant du programme (a-z, 0-9, _)
name: Réveil             # nom par défaut à la création
```

Deux cartes avec le même `schedule_id` affichent et modifient le même programme.

## Événement

À chaque exécution, l'événement `daily_planner_executed` est émis avec `schedule_id` et `name`.

## API WebSocket

`daily_planner/list`, `daily_planner/get`, `daily_planner/save`, `daily_planner/delete`, `daily_planner/run` (utilisées par la carte).

## Développement

```bash
pip install -r requirements_test.txt
python -m pytest
```
