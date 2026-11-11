"""Unit and integration tests for Phase 3 (Semantic Router) & Phase 4 (Consolidation).

Run:
  python memory-service/test_v2_features.py
"""
import sys
import os
import json
import unittest
import numpy as np

# Ensure memory-service dir is in sys.path
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import chromadb
from chromadb.utils import embedding_functions

from router import SemanticRouter, PERSONA_ANCHORS
import consolidator

class TestSemanticRouter(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.embedding_fn = embedding_functions.DefaultEmbeddingFunction()
        cls.router = SemanticRouter(cls.embedding_fn)

    def test_anchor_matrices_initialized(self):
        self.assertEqual(len(self.router.persona_matrices), 6)
        for p_id in ["kratos", "dante", "vergil", "jiraiya", "naruto", "anya"]:
            self.assertIn(p_id, self.router.persona_matrices)
            self.assertEqual(self.router.persona_matrices[p_id].shape[1], 384)

    def test_semantic_routing_accuracy(self):
        cases = [
            ("I need to focus on heavy lifting and Spartan combat discipline.", "kratos"),
            ("Let's eat hot pizza and do some wild party tricks!", "dante"),
            ("Show me your motivation and tactical swordsmanship.", "vergil"),
            ("Can you give me romantic advice and wisdom on relationships?", "jiraiya"),
            ("I'll never give up on my ninja dream, believe it!", "naruto"),
            ("Waku waku! Are we on a secret spy adventure with peanuts?", "anya"),
        ]
        for query, expected_persona in cases:
            res = self.router.route(query)
            self.assertEqual(
                res["selected_persona"],
                expected_persona,
                f"Query '{query}' expected {expected_persona}, got {res['selected_persona']}"
            )
            self.assertEqual(res["method"], "semantic")
            self.assertGreater(res["confidence"], 0.35)

    def test_sticky_short_queries(self):
        # Short query (< 4 words) should stick to current_persona
        res = self.router.route("Why?", current_persona="dante")
        self.assertEqual(res["selected_persona"], "dante")
        self.assertEqual(res["method"], "sticky_short")

        res2 = self.router.route("Tell me more.", current_persona="vergil")
        self.assertEqual(res2["selected_persona"], "vergil")
        self.assertEqual(res2["method"], "sticky_short")

    def test_low_confidence_fallback(self):
        # Gibberish or random numbers should have low similarity and fall back
        res = self.router.route("1029384756 9988776655 44332211", current_persona="jiraiya", confidence_threshold=0.5)
        if res["confidence"] < 0.5:
            self.assertEqual(res["selected_persona"], "jiraiya")
            self.assertEqual(res["method"], "sticky_low_confidence")


class TestConsolidator(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = chromadb.Client()
        cls.embedding_fn = embedding_functions.DefaultEmbeddingFunction()
        cls.collection = cls.client.create_collection(
            "test_consolidation",
            embedding_function=cls.embedding_fn
        )

    def setUp(self):
        # Clear collection before each test
        existing = self.collection.get()
        if existing["ids"]:
            self.collection.delete(ids=existing["ids"])

    def test_distillation_and_deduplication(self):
        # Seed test raw turns
        self.collection.add(
            ids=["raw-1", "raw-2"],
            documents=["I work at Google as a distributed systems engineer.", "I love drinking black coffee."],
            metadatas=[
                {
                    "persona_id": "kratos",
                    "persona_name": "Kratos",
                    "user_message": "I work at Google as a distributed systems engineer.",
                    "reply": "Good. Build strong systems.",
                    "source": "user",
                    "target": "kratos",
                    "visibility": "private",
                    "memory_type": "raw_turn",
                },
                {
                    "persona_id": "kratos",
                    "persona_name": "Kratos",
                    "user_message": "I love drinking black coffee.",
                    "reply": "Bitter, as it should be.",
                    "source": "user",
                    "target": "kratos",
                    "visibility": "private",
                    "memory_type": "raw_turn",
                }
            ]
        )

        self.assertEqual(self.collection.count(), 2)

        # Mock the ollama call to test ETL logic deterministically
        original_distill = consolidator.call_ollama_distill
        try:
            consolidator.call_ollama_distill = lambda text, **kwargs: [
                {
                    "fact": "The user is a distributed systems engineer at Google.",
                    "category": "career",
                    "visibility": "public",
                    "target": "all"
                },
                {
                    "fact": "The user prefers drinking black coffee.",
                    "category": "preference",
                    "visibility": "public",
                    "target": "all"
                }
            ]

            # Run consolidation batch
            res = consolidator.consolidate_batch(self.collection, batch_size=10)
            self.assertEqual(res["status"], "completed")
            self.assertEqual(res["processed"], 2)
            self.assertEqual(res["facts_added"], 2)

            # Raw turns should be pruned from ChromaDB
            remaining_raw = self.collection.get(where={"memory_type": {"$eq": "raw_turn"}})
            self.assertEqual(len(remaining_raw["ids"]), 0)

            # Consolidated facts should be present
            facts = self.collection.get(where={"memory_type": {"$eq": "consolidated_fact"}})
            self.assertEqual(len(facts["ids"]), 2)
            self.assertEqual(facts["metadatas"][0]["visibility"], "public")
            self.assertEqual(facts["metadatas"][0]["source"], "consolidation")

            # Test deduplication: run second batch with duplicate fact
            self.collection.add(
                ids=["raw-3"],
                documents=["I work at Google as a systems engineer."],
                metadatas=[{
                    "persona_id": "dante",
                    "persona_name": "Dante",
                    "user_message": "I work at Google as a systems engineer.",
                    "reply": "Cool job!",
                    "source": "user",
                    "target": "dante",
                    "visibility": "private",
                    "memory_type": "raw_turn",
                }]
            )

            consolidator.call_ollama_distill = lambda text, **kwargs: [
                {
                    # Semantically nearly identical to existing fact
                    "fact": "The user is a distributed systems engineer at Google.",
                    "category": "career",
                    "visibility": "public",
                    "target": "all"
                }
            ]

            res2 = consolidator.consolidate_batch(self.collection, batch_size=10)
            self.assertEqual(res2["status"], "completed")
            # Duplicate fact should be skipped!
            self.assertEqual(res2["facts_added"], 0)

            # Archive file must exist and contain JSONL
            self.assertTrue(os.path.exists(consolidator.ARCHIVE_PATH))
            with open(consolidator.ARCHIVE_PATH, "r", encoding="utf-8") as f:
                lines = f.readlines()
                self.assertGreaterEqual(len(lines), 3)

        finally:
            consolidator.call_ollama_distill = original_distill

    def test_preemption_abort(self):
        self.collection.add(
            ids=["raw-abort"],
            documents=["Some raw message"],
            metadatas=[{
                "persona_id": "anya",
                "persona_name": "Anya",
                "user_message": "Some raw message",
                "reply": "Waku waku",
                "source": "user",
                "target": "anya",
                "visibility": "private",
                "memory_type": "raw_turn",
            }]
        )
        # Abort condition is True immediately
        res = consolidator.consolidate_batch(
            self.collection,
            batch_size=10,
            is_aborted=lambda: True
        )
        self.assertEqual(res["status"], "aborted")
        self.assertEqual(res["processed"], 0)
        # Raw turn remains untouched
        self.assertEqual(self.collection.count(), 1)


if __name__ == "__main__":
    unittest.main()

