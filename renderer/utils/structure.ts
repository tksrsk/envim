export class Structure<T> {
  private item: T;

  constructor(init: T) {
    this.item = JSON.parse(JSON.stringify(init));
  }

  private deepcopy(s: any, t: any) {
    if (s instanceof Array) {
      s = t instanceof Array ? t : s;
    } else if (s instanceof Object) {
      Object.keys(s).forEach(k => {
        s[k] = t instanceof Object && k in t ? this.deepcopy(s[k], t[k]) : s[k];
      });
    } else {
      return t;
    }

    return s;
  }

  get() {
    return this.item;
  }

  set(item: T) {
    this.item = this.deepcopy(this.item, item);
  }
}
