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


if __name__ == "__main__":
    unittest.main()
