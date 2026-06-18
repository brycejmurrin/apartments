.PHONY: install crawl serve test

# Install Python dependencies.
install:
	pip install -r requirements.txt

# Run the crawler on this machine and publish results (commit + push).
# Must run from a residential IP — listing sites block datacenter/cloud IPs.
crawl:
	./scripts/crawl.sh

# Preview the dashboard locally at http://localhost:8000
serve:
	python -m http.server -d docs 8000

# Run the unit tests (parsing logic, no network).
test:
	python -m pytest -q
