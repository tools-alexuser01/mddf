module.exports = function (n, size) {
    var current = [n,0];
    var next = [];
    var queue = [];
    
    return function (cb) {
        if (queue.length) return queue.shift();
        if (current.length === 0) {
            current = next;
            next = [];
        }
        if (current.length === 0) return null;
        
        var x = current.shift();
        var dir = current.shift();
        queue.push(x);
        
        var parent = Math.floor((x - 1) / 2);
        var side = (x - 1) % 2 + 1;
        
        var left = x * 2 + 1;
        var right = (x + 1) * 2;
        if (parent >= 0 && dir !== side) next.push(parent, -side);
        if (left < size && dir !== -1) next.push(left, 1);
        if (right < size && dir !== -2) next.push(right, 2);
        return queue.shift();
    };
};
