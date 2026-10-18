import inspect
import unittest
from datetime import datetime, timezone

import opportunity


class OpportunityUtilityTests(unittest.TestCase):
    def test_strip_html(self):
        self.assertEqual(
            opportunity.strip_html("<p>Data&nbsp;entry</p><script>x</script><p>Remote</p>"),
            "Data entry\nRemote",
        )

    def test_parse_epoch_seconds_and_milliseconds(self):
        seconds = opportunity.parse_datetime(1_700_000_000)
        millis = opportunity.parse_datetime(1_700_000_000_000)
        self.assertIsNotNone(seconds)
        self.assertEqual(seconds, millis)

    def test_query_requires_all_terms_in_job_text(self):
        job = {
            "title": "Data Entry Assistant",
            "company": "Example Ltd",
            "location": "Remote",
            "description": "Input spreadsheet records accurately.",
            "summary": "",
            "employment_type": None,
            "seniority": None,
            "tags": [],
        }
        self.assertTrue(opportunity._matches_query(job, "data entry"))
        self.assertFalse(opportunity._matches_query(job, "data scientist"))

    def test_date_filter_excludes_unknown_publication_date(self):
        self.assertIsNone(opportunity._date_filter({"published_at": None}, datetime.now(timezone.utc)))

    def test_dedupe_merges_sources_and_keeps_description(self):
        one = {
            "title": "Data Entry Clerk",
            "company": "Example Ltd",
            "location": "Worldwide",
            "job_url": "https://example.com/jobs/1?utm_source=feed",
            "description": "Short",
            "summary": "Short",
            "source_links": [{"source": "A", "url": "https://example.com/jobs/1"}],
            "tags": [],
            "salary_min": None,
            "salary_max": None,
            "salary_currency": None,
            "salary_period": None,
            "employment_type": None,
            "seniority": None,
            "published_at": None,
        }
        two = {
            **one,
            "job_url": "https://jobs.example.net/entry-role",
            "description": "A much more detailed description.",
            "summary": "Detailed role summary.",
            "source_links": [{"source": "B", "url": "https://jobs.example.net/entry-role"}],
            "tags": ["Data Entry"],
        }
        jobs, removed = opportunity._dedupe([one, two])
        self.assertEqual(removed, 1)
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["description"], "A much more detailed description.")
        self.assertEqual(len(jobs[0]["source_links"]), 2)
        self.assertIn("Data Entry", jobs[0]["tags"])

    def test_make_job_has_expected_full_details(self):
        job = opportunity._make_job(
            source_id="test",
            source_name="Test source",
            title="Data Entry",
            company="Company",
            url="https://example.com/jobs/123",
            description="<p>Full description</p>",
            published_at="2026-10-12T12:00:00Z",
            location="Remote / worldwide",
            tags=["Entry level"],
        )
        self.assertIsNotNone(job)
        self.assertEqual(job["description"], "Full description")
        self.assertEqual(job["published_at"], "2026-10-12T12:00:00Z")
        self.assertEqual(job["job_url"], "https://example.com/jobs/123")

    def test_all_source_adapters_accept_common_call_signature(self):
        # search_jobs invokes each adapter as runner(query, days). This regression
        # test catches the Colab error where several adapters accepted fewer args.
        for source_id, (_label, runner) in opportunity.SOURCE_RUNNERS.items():
            with self.subTest(source=source_id):
                inspect.signature(runner).bind("data entry", 5)

    def test_list_employment_type_is_printable_text(self):
        job = opportunity._make_job(
            source_id="test",
            source_name="Test source",
            title="Data Entry",
            company="Company",
            url="https://example.com/jobs/124",
            employment_type=["Contract"],
        )
        self.assertIsNotNone(job)
        self.assertEqual(job["employment_type"], "Contract")

    def test_query_relevance_rejects_unrelated_role_with_scattered_keywords(self):
        job = {
            "title": "Senior Staff Software Engineer",
            "company": "Example Fintech",
            "location": "Remote",
            "description": "Build integrations for customers. Work with data systems. Maintain the entry pipeline for financial products.",
            "summary": "Build integrations for customers and maintain production systems.",
            "employment_type": "Full-Time",
            "seniority": "Senior",
            "tags": ["Software Engineering"],
        }
        score, reason = opportunity._query_relevance(job, "data entry")
        self.assertEqual(score, 20)
        self.assertIn("scattered", reason)
        self.assertFalse(opportunity._matches_query(job, "data entry"))

    def test_exact_title_phrase_is_a_strong_match(self):
        job = {
            "title": "Data Entry Clerk",
            "company": "Example Ltd",
            "location": "Remote",
            "description": "Enter records accurately.",
            "summary": "Enter records accurately.",
            "employment_type": None,
            "seniority": None,
            "tags": [],
        }
        score, reason = opportunity._query_relevance(job, "data entry")
        self.assertEqual(score, 100)
        self.assertIn("title", reason)
        self.assertTrue(opportunity._matches_query(job, "data entry"))

    def test_description_only_exact_phrase_is_review_not_strong_match(self):
        job = {
            "title": "Operations Associate",
            "company": "Example Ltd",
            "location": "Remote",
            "description": "The team performs occasional data entry alongside many other duties.",
            "summary": "Help the operations team coordinate workflows.",
            "employment_type": None,
            "seniority": None,
            "tags": [],
        }
        score, reason = opportunity._query_relevance(job, "data entry")
        self.assertEqual(score, 35)
        self.assertIn("review", reason)
        self.assertFalse(opportunity._matches_query(job, "data entry"))

    def test_data_entry_query_accepts_related_job_title(self):
        job = {
            "title": "Data Encoder",
            "company": "Example Ltd",
            "location": "Remote",
            "description": "Encode customer records accurately.",
            "summary": "Encode customer records accurately.",
            "employment_type": None,
            "seniority": None,
            "tags": [],
        }
        score, reason = opportunity._query_relevance(job, "data entry")
        self.assertGreaterEqual(score, 45)
        self.assertIn("related title", reason)

    def test_long_description_is_not_used_as_unbounded_summary(self):
        body = ("General operations duties. " * 40) + "Occasional data entry work."
        job = opportunity._make_job(
            source_id="test",
            source_name="Test source",
            title="Operations Associate",
            company="Example Ltd",
            url="https://example.com/jobs/125",
            description=body,
            summary=body,
        )
        self.assertIsNotNone(job)
        self.assertLessEqual(len(job["summary"]), 500)
        score, reason = opportunity._query_relevance(job, "data entry")
        self.assertLess(score, 45)
        self.assertTrue("review" in reason or score == 0)

    def test_remotejobs_source_is_registered_and_uses_common_signature(self):
        self.assertIn("remotejobsorg", opportunity.SOURCE_RUNNERS)
        runner = opportunity.SOURCE_RUNNERS["remotejobsorg"][1]
        inspect.signature(runner).bind("data entry", 5)

    def test_location_filter_accepts_country_from_explicit_region_scope(self):
        job = {"location": "Remote | Regions: Africa"}
        self.assertTrue(opportunity._matches_location(job, "Nigeria"))

    def test_remotejobs_mapping_keeps_allowed_country_eligibility(self):
        job = opportunity._remotejobs_job({
            "id": "test-job",
            "title": "Data Entry Clerk",
            "company": {"name": "Example Ltd"},
            "url": "https://remotejobs.org/remote-jobs/test-job",
            "apply_url": "https://remotejobs.org/remote-jobs/test-job",
            "location": "Remote",
            "location_normalization": {
                "scope": "country",
                "work_arrangement": "remote",
                "allowed_countries": ["NG"],
                "regions": [],
            },
            "description": "Enter records accurately.",
            "posted_at": "2026-10-17T12:00:00Z",
            "type": "Full-time",
            "category": {"name": "General", "slug": "general"},
            "salary_min": None,
            "salary_max": None,
        })
        self.assertIsNotNone(job)
        self.assertIn("Nigeria", job["location"])
        self.assertTrue(opportunity._matches_location(job, "Nigeria"))


if __name__ == "__main__":
    unittest.main()
