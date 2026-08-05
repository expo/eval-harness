import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
CATALOG = ROOT / "test_properties.json"


def duplicate_property_ids(properties: list[dict[str, object]]) -> list[str]:
    seen: set[str] = set()
    duplicates: set[str] = set()

    for property_record in properties:
        property_id = property_record.get("id")
        if not isinstance(property_id, str):
            continue
        if property_id in seen:
            duplicates.add(property_id)
        seen.add(property_id)

    return sorted(duplicates)


class PropertyCatalogTests(unittest.TestCase):
    def test_spec_property_ids_are_unique_in_catalog(self) -> None:
        """Property: every catalog property has one unique stable ID.

        Oracle: independent set membership while visiting the catalog once.
        Catches: ambiguous status joins and accidental property-ID reuse.
        """
        catalog = json.loads(CATALOG.read_text(encoding="utf-8"))

        self.assertEqual(duplicate_property_ids(catalog["properties"]), [])

    def test_spec_duplicate_id_check_compares_ids_not_complete_objects(self) -> None:
        """Property: different records that share an ID are duplicates.

        Oracle: two explicit records with the same independently chosen ID.
        Catches: relying on JSON Schema uniqueItems for member uniqueness.
        """
        properties = [
            {"id": "SCORE-001", "title": "First claim"},
            {"id": "SCORE-001", "title": "Different claim"},
        ]

        self.assertEqual(duplicate_property_ids(properties), ["SCORE-001"])


if __name__ == "__main__":
    unittest.main()
