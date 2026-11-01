"""Approved card-back identifiers accepted by account profiles."""

DEFAULT_CARD_BACKS = {"golf": "argyle", "handandfoot": "single-leaves"}

CARD_BACK_DESIGNS = {
    "golf": frozenset(
        {
            "argyle",
            "compass",
            "leaf-pair",
            "fern-sprig",
            "ginkgo",
            "four-leaf",
            "solitaire-bold",
            "north-star",
            "laurel-seal",
            "acorn",
            "jasmine",
            "lotus",
            "celestial-seal",
            "diamond-linen",
            "crossed-irons",
            "heritage-gingham",
            "glen-plaid",
            "tattersall",
            "country-tartan",
            "harlequin",
            "madras-plaid",
            "diamond-lattice",
            "scallop",
            "fern",
            "wildflower",
            "garden-trellis",
            "petal-tile",
            "leaf-stripe",
            "layered-fan",
        }
    )
}

# Hand & Foot approved designs, published from the corner approval snapshot.
CARD_BACK_DESIGNS["handandfoot"] = frozenset([
    "single-leaves",
    "royal-fan",
    "heart-locket",
    "diamond-cut",
    "suit-ribbon",
    "the-cut",
    "trump-crest",
    "jokers-bells",
    "house-chip",
    "roulette-rose",
    "club-lounge",
    "open-book",
    "page-rosette",
    "seven-card-book",
    "grand-folio",
    "concertina",
    "between-bookends",
    "midnight-reader",
    "by-candlelight",
    "paper-heart",
    "literary-butterfly",
    "story-tree",
    "pressed-pages",
    "chapter-seal",
    "page-compass",
    "leaf-pair",
    "fern-sprig",
    "ginkgo",
    "laurel-seal",
    "acorn",
    "jasmine",
    "lotus",
    "celestial-seal",
    "north-star",
    "compass"
])
