CLEAN_TESTS="rm -f tests/*.teal tests/index.js* tests/dryruns/*"

test:
	eval ${CLEAN_TESTS}
	cd tests && cp ../*.teal . && npx tsc && npx jest

clean:
	eval ${CLEAN_TESTS}

lint:
	cd tests && npx eslint index.ts

fix:
	cd tests && npx eslint index.ts --fix

init:
	cd tests && mkdir -p dryruns && npm i
