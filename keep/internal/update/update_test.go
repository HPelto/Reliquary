package update

import "testing"

func TestNewer(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"0.1.14", "0.1.13", true},   // patch bump
		{"0.1.13", "0.1.13", false},  // equal is not newer
		{"0.1.13", "0.1.14", false},  // older
		{"0.1.10", "0.1.9", true},    // numeric, not lexical (10 > 9)
		{"0.2.0", "0.1.99", true},    // minor outranks patch
		{"1.0.0", "0.9.9", true},     // major outranks all
		{"v0.1.14", "0.1.13", true},  // leading v ignored
		{"0.1.14", "v0.1.13", true},  // leading v ignored on either side
		{"0.1", "0.1.0", false},      // missing component reads as 0
		{"0.1.1", "0.1", true},       // extra component counts
		{"garbage", "0.1.13", false}, // unparseable never reads as newer
	}
	for _, c := range cases {
		if got := newer(c.a, c.b); got != c.want {
			t.Errorf("newer(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}
