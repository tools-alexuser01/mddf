var fs = require('fs');
var Buffer = require('buffer').Buffer;
var proximity = require('./lib/proximity.js');
var dist = require('euclidean-distance');
var defined = require('defined');

module.exports = MDDF;

function MDDF (opts) {
    if (!(this instanceof MDDF)) return new MDDF(opts);
    
    this._reader = opts.read;
    this._writer = opts.write;
    
    this.blksize = opts.blksize || 4096;
    this.dim = opts.dim;
    this.B = Math.floor((this.blksize - 4) / (this.dim * 4 + 4));
    this.size = defined(opts.size, 0);
    this.queue = [];
    
    this.alpha = defined(opts.alpha, 0.5);
    this.depth = defined(opts.depth, 0);
    this.blocks = defined(opts.blocks, this.size === 0 ? 0 : undefined);
    
    this.logia = Math.log(1 / this.alpha);
    // height(tree) <= log(NodeCount)/log(1/alpha) + 1
}

MDDF.prototype.put = function (pt, value, cb) {
    var self = this;
    this.queue.push([ pt.slice(), value, cb ]);
    if (this.queue.length !== 1) return;
    (function next () {
        var q = self.queue[0];
        self._put(q[0], q[1], function (err, index, depth) {
            var cb = q[2];
            if (!err && self.blocks !== undefined) {
                self.blocks ++;
                if (depth > Math.log(self.blocks) / self.logia + 1) {
                    return self._scapegoat(index, function (e) {
                        if (e) err = e;
                        finish();
                    });
                }
            }
            finish();
            
            function finish () {
                if (cb) cb(err);
                self.queue.shift();
                if (self.queue.length > 0) next();
            }
        });
    })();
};

MDDF.prototype._scapegoat = function (index, cb) {
    var self = this;
    var pivots = {};
    (function next (ix, asize) {
        var side = ix % 2; // 0: right, 1: left
        var other = side === 0 ? ix - 1 : ix + 1;
        self._size(other, function (err, bsize, pivots_) {
            if (err) return cb(err);
            Object.keys(pivots_).forEach(function (key) {
                pivots[key] = pivots_[key];
            });
            var nsize = asize + bsize + 1;
            if ((asize > self.alpha * nsize || bsize > self.alpha * nsize)
            && ix < index) {
                // candidate found at ix
                
                console.log('CANDIDATE', ix, index, pivots);
            }
            else next(Math.floor((ix-1)/2), nsize);
        });
    })(index, 1);
};

MDDF.prototype._size = function (index, cb) {
    var self = this;
    var pivots = {};
    (function readsize (ix, fn) {
        if (ix * self.blksize >= self.size) return fn(null, 0);
        self._readBlock(ix, function f (err, buf) {
            if (err) return fn(err);
            var ptlen = buf.readUInt32BE(0);
            if (ptlen === 0) return fn(null, 0);
            
            var pivot = Array(self.dim);
            for (var i = 0; i < self.dim; i++) {
                pivot[i] = buf.readFloatBE(i*4+4);
            }
            pivots[ix] = pivot;
            
            var pending = 2, sum = 1;
            readsize(ix * 2 + 1, next);
            readsize((ix + 1) * 2, next);
            
            function next (err, size) {
                if (err) return fn(err);
                sum += size;
                if (--pending === 0) fn(null, sum);
            }
        });
    })(index, function (err, size) { cb(err, size, pivots) });
};
    
MDDF.prototype._put = function (pt, value, cb) {
    var self = this;
    if (!self._writer) {
        return cb(new Error('cannot put points: no write function defined'));
    }
    if (self.dim !== pt.length) {
        return cb(new Error('inconsistent dimension'));
    }
    
    (function next (index, depth) {
        var before = self.size;
        self._readBlock(index, function (err, buf) {
            if (err) return cb(err);
            
            var ptlen = buf.readUInt32BE(0);
            var free = self._available(buf);
            var needed = self.dim * 4 + 4 + value.length + 4;
            if (needed > self.blksize) {
                return cb(new Error('block too large'));
            }
            
            if (free >= needed) {
                // not full, add point
                buf.writeUInt32BE(ptlen + 1, 0);
                var offset = 4 + ptlen * (self.dim * 4 + 4);
                for (var i = 0; i < pt.length; i++) {
                    buf.writeFloatBE(pt[i], offset + i*4);
                }
                var dataix = self._putData(buf, value);
                buf.writeUInt32BE(dataix, offset + i*4);
                
                var pending = 1;
                if (self.size > before) {
                    // allocate new blocks as empty
                    var ebuf = self._emptyBlock();
                    
                    pending = (self.size - before) / self.blksize;
                    for (var i = before; i < self.size; i += self.blksize) {
                        var b = i === index ? buf : ebuf;
                        self._writeBlock(i, ebuf, finish);
                    }
                    return;
                }
                return self._writeBlock(index, buf, finish);
                
                function finish (err) {
                    if (err) cb(err)
                    else if (-- pending === 0) cb(err, index, depth)
                }
            }
            
            var ix = depth % self.dim;
            var pivot = buf.readFloatBE(4 + ix * 4);
            
            if (pt[ix] < pivot) {
                next(index * 2 + 1, depth + 1);
            }
            else {
                next((index + 1) * 2, depth + 1);
            }
        });
    })(0, 0);
};

MDDF.prototype._putData = function (buf, value) {
    var datalen = buf.readUInt32BE(buf.length - 4);
    var offset = buf.length - 4;
    for (var i = 0; i < datalen; i++) {
        var len = buf.readUInt32BE(offset - 4);
        offset -= len + 4;
    }
    buf.writeUInt32BE(value.length, offset - 4);
    value.copy(buf, offset - value.length - 4, 0, value.length);
    buf.writeUInt32BE(datalen + 1, buf.length - 4);
    return buf.length - offset;
};

MDDF.prototype._emptyBlock = function () {
    var buf = new Buffer(this.blksize);
    buf.writeUInt32BE(0, 0); // ptlen
    buf.writeUInt32BE(0, buf.length - 4); // datalen
    return buf;
};

MDDF.prototype._available = function (buf) {
    var ptlen = buf.readUInt32BE(0);
    var datalen = buf.readUInt32BE(buf.length - 4);
    
    var free = buf.length - ptlen * (this.dim * 4 + 4) - 8;
    var offset = buf.length - 4;
    for (var i = 0; i < datalen; i++) {
        var len = buf.readUInt32BE(offset - 4);
        offset -= len + 4;
        free -= len + 4;
    }
    return free;
};

MDDF.prototype._readBlock = function (n, cb) {
    var self = this;
    var offset = n * this.blksize;
    if (offset >= this.size) {
        this.size = (n + 1) * this.blksize;
        return cb(null, this._emptyBlock());
    }
    var buf = Buffer(this.blksize);
    this._reader(buf, 0, this.blksize, offset, onread);
    
    function onread (err, bytes) {
        if (err) cb(err);
        else if (bytes === 0) {
            cb(new Error('0 bytes read'));
        }
        else if (bytes === self.blksize) {
            cb(null, buf);
        }
        else if (bytes < self.blksize) {
            self._reader(buf, bytes, self.blksize - bytes, offset, onread);
        }
        else {
            cb(null, buf.slice(0, bytes));
        }
    }
};

MDDF.prototype._writeBlock = function (n, buf, cb) {
    this._writer(buf, 0, this.blksize, n * this.blksize, cb);
};

MDDF.prototype.nn = function (pt, cb) {
    var self = this;
    var nearest = null;
    var ndist = null;
    var ndata = null;
    var noffset = null;
    var nbuf = null;
    
    self._walk(pt, function (err, ppt, offset, buf) {
        if (err) cb(err)
        else if (ppt === null) {
            var len = nbuf.readUInt32BE(nbuf.length - noffset - 4);
            var ndata = nbuf.slice(
                nbuf.length - noffset - len - 4,
                nbuf.length - noffset - 4
            );
            cb(null, nearest, ndata);
        }
        else {
            var d = dist(pt, ppt);
            if (nearest === null || d < ndist) {
                nearest = ppt;
                ndist = d;
                noffset = offset;
                nbuf = buf;
            }
        }
    });
};

MDDF.prototype.knn = function (k, pt, cb) {
    var self = this;
    var matches = [];
    for (var i = 0; i < k; i++) {
        matches.push({
            point: null,
            dist: null,
            offset: null,
            buf: null
        });
    }

    self._walk(pt, function (err, ppt, offset, buf) {
        if (err) cb(err);
        else if (ppt === null) {
            var res = mapWithData(matches);
            cb(null, res);
        }
        else {
            var d = dist(pt, ppt);
            for (var i = 0; i < matches.length; i++) {
                var m = matches[i];
                if (m.point === null) {
                    m.point = ppt;
                    m.dist = d;
                    m.offset = offset;
                    m.buf = buf;
                    break;
                }
                else if (d < m.dist) {
                    for (var j = matches.length - 1; j > i; j--) {
                        if (matches[j].point === null) break;
                        matches[j].point = matches[j-1].point;
                        matches[j].dist = matches[j-1].dist;
                        matches[j].offset = matches[j-1].offset;
                        matches[j].buf = matches[j-1].buf;
                    }
                    m = matches[i];
                    m.point = ppt;
                    m.dist = d;
                    m.offset = offset;
                    m.buf = buf;
                    break;
                }
            }
        }
    });
};

MDDF.prototype.rnn = function (r, pt, cb) {
    var self = this;
    var matches = [];

    self._walk(pt, function (err, ppt, offset, buf) {
        if (err) cb(err);
        else if (ppt === null) {
            var res = mapWithData(matches);
            cb(null, res);
        }
        else {
            var d = dist(pt, ppt);
            if(d < r){
                matches.push({
                    point: ppt,
                    buf: buf,
                    offset: offset
                });
            }
        }
    });
};

MDDF.prototype.near = function (pt) {
    var self = this;
    var current = [];
    var prox = null;
    var i, len, buf = null;
    
    return function next (cb) {
        if (prox === null) {
            return self._walkDown(pt, function (err, index) {
                if (err) return cb(err);
                prox = proximity(index, self.size / self.blksize);
                next(cb);
            });
        }
        if (buf === null) {
            var index = prox();
            if (index === null) return cb(null, null);
            
            return self._readBlock(index, function (err, buf_) {
                if (err) return cb(err);
                buf = buf_;
                i = 0;
                len = buf.readUInt32BE(0);
                next(cb);
            });
        }
        if (i >= len) {
            buf = null;
            return next(cb);
        }
        
        var ppt = [];
        for (var j = 0; j < self.dim; j++) {
            ppt.push(buf.readFloatBE(4+i*(self.dim*4+4)+j*4));
        }
        var offset = buf.readUInt32BE(4+i*(self.dim*4+4)+j*4);
        var data = buf.slice(
            buf.length - offset - len - 4,
            buf.length - offset - 4
        );
        
        cb(null, ppt, data);
        if (++i >= len) buf = null;
    };
};

MDDF.prototype._walkDown = function (pt, cb) {
    var self = this;
    (function next (index, prev, depth) {
        if (index * self.blksize >= self.size) {
            return cb(null, prev);
        }
        prev = index;
        
        self._readBlock(index, function (err, buf) {
            if (err) return cb(err);
            var ix = depth % self.dim;
            var pivot = buf.readFloatBE(4 + ix * 4);
            
            if (pt[ix] < pivot) {
                next(index * 2 + 1, index, depth + 1);
            }
            else {
                next((index + 1) * 2, index, depth + 1);
            }
        });
    })(0, 0, 0);
};

MDDF.prototype._walk = function (pt, cb) {
    var self = this;
    (function next (index, depth) {
        if (index * self.blksize >= self.size) {
            return cb(null, null);
        }
        self._readBlock(index, function (err, buf) {
            if (err) return cb(err);
            self._eachPoint(buf, cb);
            
            var ix = depth % self.dim;
            var pivot = buf.readFloatBE(4 + ix * 4);
            
            if (pt[ix] < pivot) {
                next(index * 2 + 1, depth + 1);
            }
            else {
                next((index + 1) * 2, depth + 1);
            }
        });
    })(0, 0);
};

MDDF.prototype._eachPoint = function (buf, cb) {
    var len = buf.readUInt32BE(0);
    for (var i = 0; i < len; i++) {
        var ppt = [];
        for (var j = 0; j < this.dim; j++) {
            ppt.push(buf.readFloatBE(4+i*(this.dim*4+4)+j*4));
        }
        var offset = buf.readUInt32BE(4+i*(this.dim*4+4)+j*4);
        cb(null, ppt, offset, buf);
    }
};

function mapWithData(matches){
    var res = [];
    for (var i = 0; i < matches.length; i++) {
        var m = matches[i];
        if (m.point === null) continue;
        var len = m.buf.readUInt32BE(m.buf.length - m.offset - 4);
        var data = m.buf.slice(
            m.buf.length - m.offset - len - 4,
            m.buf.length - m.offset - 4
        );
        res.push({ point: m.point, data: data });
    }
    return res;
}
